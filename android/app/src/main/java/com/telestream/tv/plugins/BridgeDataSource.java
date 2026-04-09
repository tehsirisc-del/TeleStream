package com.telestream.tv.plugins;

import android.net.Uri;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSpec;

import com.getcapacitor.JSObject;

import java.io.IOException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

public class BridgeDataSource extends BaseDataSource {

    private static final String TAG = "BridgeDataSource";
    private static final int MAX_QUEUE_SIZE = 600; // ~75MB buffer in Java memory

    private final StreamPlayerPlugin plugin;
    private final String channel;
    private final long messageId;
    private final long totalFileSize;

    private DataSpec currentDataSpec;
    private long openedPosition;
    private long currentRemaining;
    private boolean opened;

    private final LinkedBlockingQueue<byte[]> dataQueue;
    private byte[] currentChunk;
    private int currentChunkOffset;

    // Concurrency control
    private final AtomicLong currentRequestId = new AtomicLong(-1);
    private volatile boolean isJsStreamActive = false;
    
    private long totalBytesForBitrate = 0;
    private long absoluteBytesRead = 0;
    private long expectedFeedOffset = 0;
    private long lastLogTime = 0;
    
    private int consecutiveEmptyChunks = 0;
    private static final int MAX_CONSECUTIVE_EMPTY = 10;

    public BridgeDataSource(StreamPlayerPlugin plugin, String channel, long messageId, long totalFileSize) {
        super(/* isNetwork= */ false);
        this.plugin = plugin;
        this.channel = channel;
        this.messageId = messageId;
        this.totalFileSize = totalFileSize;
        this.dataQueue = new LinkedBlockingQueue<>(MAX_QUEUE_SIZE);
    }

    @Override
    public long open(@NonNull DataSpec dataSpec) throws IOException {
        long position = dataSpec.position;
        Log.d(TAG, "BridgeDataSource OPEN called – position: " + position);

        // State cleanup
        dataQueue.clear();
        currentChunk = null;
        currentChunkOffset = 0;
        openedPosition = position;
        absoluteBytesRead = position;
        expectedFeedOffset = position;
        totalBytesForBitrate = 0;
        lastLogTime = System.currentTimeMillis();

        currentRemaining = (dataSpec.length == C.LENGTH_UNSET && totalFileSize > 0)
                ? totalFileSize - position
                : dataSpec.length;

        requestJsChunk(position, currentRemaining);

        opened = true;
        transferInitializing(dataSpec);
        transferStarted(dataSpec);
        
        return currentRemaining != C.LENGTH_UNSET ? currentRemaining : C.LENGTH_UNSET;
    }

    private void requestJsChunk(long position, long remaining) {
        long reqId = System.currentTimeMillis();
        currentRequestId.set(reqId);
        isJsStreamActive = true;

        JSObject reqData = new JSObject();
        reqData.put("offset", position);
        
        long limit = remaining == C.LENGTH_UNSET ? -1 : remaining;
        reqData.put("length", limit);
        
        // CRITICAL: Send IDs as Strings to prevent bigInt precision loss in Capacitor Bridge
        reqData.put("messageId", String.valueOf(messageId));
        reqData.put("channel", channel);
        reqData.put("requestId", String.valueOf(reqId));

        plugin.emitDebug("Java request_chunk: offset=" + position + " limit=" + limit + " reqId=" + reqId, "info");
        plugin.emitEvent("request_chunk", reqData);
    }

    @Override
    public int read(@NonNull byte[] buffer, int offset, int length) throws IOException {
        if (!opened) return C.RESULT_END_OF_INPUT;
        if (currentRemaining == 0) return C.RESULT_END_OF_INPUT;

        while (true) {
            if (currentChunk == null || currentChunkOffset >= currentChunk.length) {
                // Block and wait for JavaScript to provide the next chunk
                try {
                    // We use a small timeout loop so we can abort if the player shuts down
                    while (isJsStreamActive || !dataQueue.isEmpty()) {
                        currentChunk = dataQueue.poll(500, TimeUnit.MILLISECONDS);
                        if (currentChunk != null) {
                            break;
                        }
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException("Interrupted waiting for bridge data", e);
                }

                if (currentChunk == null) {
                    if (!isJsStreamActive) return C.RESULT_END_OF_INPUT;
                    throw new IOException("Bridge stream ended unexpectedly (timeout)");
                }

                if (currentChunk.length == 0) { // EOF signal sent by JS
                    Log.d(TAG, "BridgeDataSource: EOF received from JS");
                    isJsStreamActive = false;
                    
                    consecutiveEmptyChunks++;
                    if (consecutiveEmptyChunks > MAX_CONSECUTIVE_EMPTY) {
                        plugin.updateNativeDebug("ANTI-FLOOD: Too many consecutive empty chunks. Stopping bridge.");
                        return C.RESULT_END_OF_INPUT;
                    }

                    if (currentRemaining == 0) {
                        return C.RESULT_END_OF_INPUT;
                    }
                    
                    // JS stopped sending data (EOF or Error)
                    return C.RESULT_END_OF_INPUT;
                }

                currentChunkOffset = 0;
            }
            break; // Valid chunk available, proceed to read it
        }

        int bytesToRead = Math.min(length, currentChunk.length - currentChunkOffset);
        if (currentRemaining != C.LENGTH_UNSET && bytesToRead > currentRemaining) {
            bytesToRead = (int) currentRemaining;
        }

        System.arraycopy(currentChunk, currentChunkOffset, buffer, offset, bytesToRead);
        currentChunkOffset += bytesToRead;
        absoluteBytesRead += bytesToRead;
        
        if (currentRemaining != C.LENGTH_UNSET) {
            currentRemaining -= bytesToRead;
        }
        
        totalBytesForBitrate += bytesToRead;
        long now = System.currentTimeMillis();
        if (now - lastLogTime > 5000) {
            double seconds = (now - lastLogTime) / 1000.0;
            double kbps = (totalBytesForBitrate / 1024.0) * 8.0 / seconds;
            plugin.updateNativeDebug(String.format("Bitrate: %.1f kbps | Queue: %d", kbps, dataQueue.size()));
            totalBytesForBitrate = 0;
            lastLogTime = now;
        }
        
        bytesTransferred(bytesToRead);
        return bytesToRead;
    }

    @Nullable
    @Override
    public Uri getUri() {
        return Uri.parse("tg://" + channel + "/" + messageId);
    }

    @Override
    public void close() {
        Log.d(TAG, "BridgeDataSource CLOSE called");
        if (opened) {
            opened = false;
            transferEnded();
        }
        isJsStreamActive = false;
        dataQueue.clear();
    }

    public void stopJsStream() {
        Log.d(TAG, "BridgeDataSource stopJsStream()");
        isJsStreamActive = false;
        dataQueue.clear();
        plugin.emitEvent("stop_chunk", new JSObject());
    }

    /**
     * Blocking data feed from Local HTTP Server.
     * @return true if chunk was queued, false if stream stopped or stale.
     */
    public boolean feedDataBlocking(byte[] data, long reqId, long dataOffset) {
        if (!isJsStreamActive) return false;
        
        if (reqId != currentRequestId.get()) {
            return false;
        }

        if (data == null) data = new byte[0];

        // Ensure stream integrity: if a TCP timeout caused JS to resend a chunk, 
        // silently drop the duplicate bytes we already enqueued!
        if (data.length > 0 && dataOffset < expectedFeedOffset) {
            long duplicateBytes = expectedFeedOffset - dataOffset;
            Log.w(TAG, "BridgeDataSource: Detected duplicate data. dataOffset=" + dataOffset + ", expected=" + expectedFeedOffset + ", dupBytes=" + duplicateBytes);
            if (duplicateBytes >= data.length) {
                // Entire chunk is duplicate, ignore gracefully.
                return true;
            }
            // Slice off the duplicate prefix
            byte[] sliced = new byte[data.length - (int) duplicateBytes];
            System.arraycopy(data, (int) duplicateBytes, sliced, 0, sliced.length);
            data = sliced;
            dataOffset += duplicateBytes; // sanity logic
        }

        if (data.length > 0 && dataOffset > expectedFeedOffset) {
            Log.e(TAG, "BridgeDataSource: GAP DETECTED! dataOffset=" + dataOffset + ", expected=" + expectedFeedOffset);
            // We could potentially fill with zeros or just accept it, but for now we log it.
        }

        try {
            // Blocks if queue is full (MAX_QUEUE_SIZE), applying OS-level backpressure
            dataQueue.put(data);
            if (data.length > 0) {
                expectedFeedOffset += data.length;
                consecutiveEmptyChunks = 0; // Reset on real data
            }
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }
}

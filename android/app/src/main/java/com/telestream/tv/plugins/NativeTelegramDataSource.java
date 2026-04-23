package com.telestream.tv.plugins;

import android.net.Uri;
import android.os.SystemClock;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSpec;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;

public class NativeTelegramDataSource extends BaseDataSource {
    private static final long WAIT_TIMEOUT_MS = 30_000L;
    private static final long BLOCKING_REQUEST_GRANULARITY_BYTES = 512L * 1024L;
    private static final long PREFETCH_REQUEST_GRANULARITY_BYTES = 1L * 1024L * 1024L;
    private static final long PREFETCH_LOW_WATERMARK_BYTES = 12L * 1024L * 1024L;
    private static final long REQUEST_RETRY_COOLDOWN_MS = 750L;

    private final NativeTelegramDownloadSession session;

    private RandomAccessFile file;
    private long currentPosition;
    private long remaining;
    private boolean opened;
    private long lastBlockingRequestOffset = Long.MIN_VALUE;
    private long lastPrefetchRequestOffset = Long.MIN_VALUE;
    private long lastBlockingRequestAtMs = 0L;
    private long lastPrefetchRequestAtMs = 0L;

    public NativeTelegramDataSource(NativeTelegramDownloadSession session) {
        super(true);
        this.session = session;
    }

    @Override
    public long open(@NonNull DataSpec dataSpec) throws IOException {
        long position = dataSpec.position;
        requestBytesAt(position, true);

        if (!session.awaitReadable(Math.max(1L, position + 1L), WAIT_TIMEOUT_MS)) {
            throw new IOException("Timed out waiting for native Telegram file bootstrap");
        }

        String path = session.getLocalPath();
        if (path == null || path.isEmpty()) {
            throw new IOException("Native Telegram file path is empty");
        }

        file = new RandomAccessFile(new File(path), "r");
        file.seek(position);
        currentPosition = position;
        remaining = dataSpec.length == C.LENGTH_UNSET ? C.LENGTH_UNSET : dataSpec.length;
        opened = true;

        transferInitializing(dataSpec);
        transferStarted(dataSpec);

        long totalSize = session.getTotalSize();
        if (remaining != C.LENGTH_UNSET) {
            return remaining;
        }
        return totalSize > 0 ? Math.max(0L, totalSize - position) : C.LENGTH_UNSET;
    }

    @Override
    public int read(@NonNull byte[] buffer, int offset, int length) throws IOException {
        if (!opened) {
            return C.RESULT_END_OF_INPUT;
        }
        if (remaining == 0) {
            return C.RESULT_END_OF_INPUT;
        }

        while (true) {
            long availableFrom = session.getAvailableFrom();
            long availableUntil = session.getAvailableUntil();
            if (currentPosition < availableFrom || currentPosition >= availableUntil) {
                requestBytesAt(currentPosition, true);
                availableFrom = session.getAvailableFrom();
                availableUntil = session.getAvailableUntil();
            } else if (!session.isCompleted() && (availableUntil - currentPosition) <= PREFETCH_LOW_WATERMARK_BYTES) {
                requestBytesAt(Math.max(currentPosition, availableUntil), false);
            }
            if (currentPosition >= availableFrom && currentPosition < availableUntil) {
                break;
            }
            if (session.isCompleted()) {
                return C.RESULT_END_OF_INPUT;
            }
            if (!session.awaitReadable(currentPosition + 1L, WAIT_TIMEOUT_MS)) {
                throw new IOException("Timed out waiting for native Telegram bytes");
            }
        }

        long availableBytes = session.getAvailableUntil() - currentPosition;
        int bytesToRead = (int) Math.min(length, availableBytes);
        if (remaining != C.LENGTH_UNSET) {
            bytesToRead = (int) Math.min(bytesToRead, remaining);
        }

        int bytesRead = file.read(buffer, offset, bytesToRead);
        if (bytesRead == -1) {
            if (session.isCompleted()) {
                return C.RESULT_END_OF_INPUT;
            }
            throw new IOException("Native Telegram file ended before download completed");
        }

        currentPosition += bytesRead;
        if (remaining != C.LENGTH_UNSET) {
            remaining -= bytesRead;
        }
        bytesTransferred(bytesRead);
        return bytesRead;
    }

    @Nullable
    @Override
    public Uri getUri() {
        return Uri.parse("tg-native://" + session.getPeerType() + "/" + session.getPeerId() + "/" + session.getMessageId());
    }

    @Override
    public void close() throws IOException {
        if (!opened) {
            return;
        }
        opened = false;
        if (file != null) {
            file.close();
            file = null;
        }
        transferEnded();
    }

    private void requestBytesAt(long offset, boolean blocking) {
        long normalizedOffset = Math.max(0L, offset);
        long now = SystemClock.elapsedRealtime();
        long availableFrom = session.getAvailableFrom();
        long availableUntil = session.getAvailableUntil();
        long lastOffset = blocking ? lastBlockingRequestOffset : lastPrefetchRequestOffset;
        long lastRequestAtMs = blocking ? lastBlockingRequestAtMs : lastPrefetchRequestAtMs;
        long granularityBytes = blocking
                ? BLOCKING_REQUEST_GRANULARITY_BYTES
                : PREFETCH_REQUEST_GRANULARITY_BYTES;

        boolean movedEnough =
                lastOffset == Long.MIN_VALUE ||
                        Math.abs(normalizedOffset - lastOffset) >= granularityBytes;
        boolean outsideReadableWindow =
                normalizedOffset < availableFrom || normalizedOffset >= availableUntil;
        boolean retryAllowed = (now - lastRequestAtMs) >= REQUEST_RETRY_COOLDOWN_MS;

        if (!movedEnough) {
            if (!(outsideReadableWindow && retryAllowed)) {
                return;
            }
        }

        if (blocking) {
            TelegramNativeManager.prioritizeDownloadBlocking(session.getFileId(), normalizedOffset);
            lastBlockingRequestOffset = normalizedOffset;
            lastBlockingRequestAtMs = now;
        } else {
            TelegramNativeManager.prioritizeDownloadAsync(session.getFileId(), normalizedOffset);
            lastPrefetchRequestOffset = normalizedOffset;
            lastPrefetchRequestAtMs = now;
        }
    }
}

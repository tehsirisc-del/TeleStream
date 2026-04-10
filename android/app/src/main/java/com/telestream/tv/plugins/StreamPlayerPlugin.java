package com.telestream.tv.plugins;

import android.app.Dialog;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.util.Log;
import android.view.Window;
import android.view.WindowManager;

import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.ui.PlayerView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.UUID;

@CapacitorPlugin(name = "StreamPlayer")
public class StreamPlayerPlugin extends Plugin {

    private static final String TAG = "StreamPlayer";
    private ExoPlayer player;
    private PlayerView playerView;
    private Dialog dialog;
    private long pendingSeekTo = 0;
    private long currentSessionId = 0;

    private android.widget.TextView debugTextView;
    private android.widget.ScrollView debugScrollView;

    private android.widget.TextView seekIndicator;
    private Runnable hideSeekIndicatorRunnable;



    private ShareServer shareServer = null;

    private BridgeDataSource currentBridgeDataSource;
    private LocalFeedServer localFeedServer;

    private final ConcurrentHashMap<String, CompletableFuture<JSObject>> pendingMetadataRequests = new ConcurrentHashMap<>();

    @PluginMethod
    public void play(PluginCall call) {
        final long messageId = Long.parseLong(call.getString("messageId", "0"));
        final String channel = call.getString("channel", "");
        final String title = call.getString("title", "Video");
        
        // Robust numeric extraction: Capacitor often mis-types these as strings/doubles
        // call.getData() returns a JSObject (JSONObject) which has optLong()
        final long fileSize = call.getData().optLong("fileSize", 0L);
        final long seekTo = call.getData().optLong("progress", 0L) * 1000L;
        final long seekStepMs = call.getData().optLong("seekStep", 15L) * 1000L;

        Log.d(TAG, "play() messageId=" + messageId
                + " channel=" + channel + " title=" + title
                + " fileSize=" + fileSize + " seekTo=" + seekTo + " seekStep=" + seekStepMs);

        getActivity().runOnUiThread(() -> {
            try {
                currentSessionId++;
                releasePlayer(true); // Is transitioning so we skip player_closed event
                setupPlayerAndDialog(channel, messageId, fileSize, title, seekTo, seekStepMs, currentSessionId);
                call.resolve();
            } catch (Exception e) {
                Log.e(TAG, "setupPlayerAndDialog failed", e);
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void provideChunk(PluginCall call) {
        // Obsolete: Replaced by local HTTP streaming
        JSObject ret = new JSObject();
        ret.put("accepted", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            releasePlayer(false); // Explicit close by user
            call.resolve();
        });
    }

    @PluginMethod
    public void startShareServer(PluginCall call) {
        String token = call.getString("token", "");
        if (shareServer != null) {
            shareServer.stopServer();
        }
        shareServer = new ShareServer(token);
        shareServer.start();
        call.resolve();
    }

    @PluginMethod
    public void stopShareServer(PluginCall call) {
        if (shareServer != null) {
            shareServer.stopServer();
            shareServer = null;
        }
        if (call != null)
            call.resolve();
    }

    @PluginMethod
    public void logToNative(PluginCall call) {
        String msg = call.getString("msg", "");
        String level = call.getString("level", "info");
        updateNativeDebug("[" + level.toUpperCase() + "] " + msg);
        call.resolve();
    }

    @PluginMethod
    public void sendMetadataResponse(PluginCall call) {
        String requestId = call.getString("requestId");
        JSObject data = call.getObject("data");
        
        if (requestId != null && pendingMetadataRequests.containsKey(requestId)) {
            CompletableFuture<JSObject> future = pendingMetadataRequests.remove(requestId);
            if (future != null) {
                future.complete(data);
            }
        }
        call.resolve();
    }

    public void updateNativeDebug(final String text) {
        getActivity().runOnUiThread(() -> {
            if (debugTextView != null) {
                String time = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
                        .format(new java.util.Date());
                debugTextView.append("[" + time + "] " + text + "\n");
                debugScrollView.post(() -> debugScrollView.fullScroll(android.view.View.FOCUS_DOWN));
            }
        });
    }



    private void releasePlayer(boolean isTransitioning) {
        long finalPos = 0;
        long finalDur = 0;

        if (currentBridgeDataSource != null) {
            currentBridgeDataSource.stopJsStream(); // Unblocks any indefinitely hanging read() loop immediately
            currentBridgeDataSource = null;
        }

        if (player != null) {
            finalPos = player.getCurrentPosition();
            finalDur = player.getDuration();
            player.stop();
            player.release();
            player = null;
        }

        if (dialog != null) {
            dialog.setOnDismissListener(null);
            dialog.dismiss();
            dialog = null;
        }

        if (!isTransitioning) {
            try {
                // Return exact stop position to JS before the player is destroyed
                JSObject data = new JSObject();
                data.put("progress", finalPos);
                data.put("duration", finalDur);
                emitEvent("player_closed", data);
            } catch (Exception e) {}
        }

        if (localFeedServer != null) {
            localFeedServer.stopServer();
            localFeedServer = null;
        }
        if (hideSeekIndicatorRunnable != null && getContext() != null) {
            // Cleanup any pending UI hide
        }
    }

    private void setupPlayerAndDialog(String channel, long messageId, long fileSize, String title,
            long seekTo, long seekStepMs, long sessionId) {
        Log.d(TAG, "setupPlayerAndDialog title=" + title);

        // ── Full-screen dialog ──────────────────────────────────────────────────
        dialog = new Dialog(getContext(), android.R.style.Theme_Black_NoTitleBar_Fullscreen);

        android.widget.FrameLayout rootLayout = new android.widget.FrameLayout(getContext());
        playerView = new PlayerView(getContext());
        rootLayout.addView(playerView);

        // ── Native Debug Console ────────────────────────────────────────────────
        debugScrollView = new android.widget.ScrollView(getContext());
        debugScrollView.setLayoutParams(new android.widget.FrameLayout.LayoutParams(
                (int) (getContext().getResources().getDisplayMetrics().widthPixels * 0.45),
                (int) (getContext().getResources().getDisplayMetrics().heightPixels * 0.6)));
        debugScrollView.setBackgroundColor(Color.argb(200, 0, 0, 0));
        debugScrollView.setPadding(20, 20, 20, 20);
        debugScrollView.setVisibility(android.view.View.GONE); // Default off

        debugTextView = new android.widget.TextView(getContext());
        debugTextView.setTextColor(Color.GREEN);
        debugTextView.setTypeface(android.graphics.Typeface.MONOSPACE);
        debugTextView.setTextSize(10);
        debugTextView.setText("--- Native Debug Console ---\n");
        debugTextView.append("Device: " + android.os.Build.MODEL + "\n");
        debugScrollView.addView(debugTextView);
        rootLayout.addView(debugScrollView);

        // Progress feedback setup moved below to be internal to playerView

        hideSeekIndicatorRunnable = () -> {
            if (seekIndicator != null) {
                seekIndicator.animate().alpha(0f).scaleX(0.8f).scaleY(0.8f).setDuration(250).withEndAction(() -> {
                    seekIndicator.setVisibility(android.view.View.GONE);
                }).start();
            }
        };


        // ── Integrated Debug Icon (Inside PlayerView) ────────────────────────
        android.widget.ImageButton debugIcon = new android.widget.ImageButton(getContext());
        debugIcon.setImageResource(android.R.drawable.ic_menu_info_details);
        debugIcon.setBackgroundColor(Color.TRANSPARENT);
        debugIcon.setAlpha(0.5f);
        debugIcon.setFocusable(true);
        debugIcon.setPadding(20, 20, 20, 20);
        android.widget.FrameLayout.LayoutParams bugParams = new android.widget.FrameLayout.LayoutParams(
                120, 120);
        bugParams.gravity = android.view.Gravity.TOP | android.view.Gravity.RIGHT;
        bugParams.setMargins(0, 40, 40, 0);
        debugIcon.setLayoutParams(bugParams);
        
        debugIcon.setOnClickListener(v -> {
            int vis = debugScrollView.getVisibility() == android.view.View.VISIBLE ? android.view.View.GONE
                    : android.view.View.VISIBLE;
            debugScrollView.setVisibility(vis);
        });
        
        debugIcon.setOnFocusChangeListener((v, hasFocus) -> {
            debugIcon.setAlpha(hasFocus ? 1.0f : 0.5f);
            debugIcon.setScaleX(hasFocus ? 1.2f : 1.0f);
            debugIcon.setScaleY(hasFocus ? 1.2f : 1.0f);
        });
        
        playerView.addView(debugIcon);

        // Visibility sync: Show debug button only when controller is visible
        playerView.setControllerVisibilityListener(new PlayerView.ControllerVisibilityListener() {
            @Override
            public void onVisibilityChanged(int visibility) {
                debugIcon.setVisibility(visibility);
            }
        });

        // ── "Internal" Seek Indicator (Inside PlayerView) ──────────────────────
        seekIndicator = new android.widget.TextView(getContext());
        seekIndicator.setTextSize(36);
        seekIndicator.setTextColor(Color.WHITE);
        seekIndicator.setPadding(60, 30, 60, 30);
        seekIndicator.setGravity(android.view.Gravity.CENTER);
        android.graphics.drawable.GradientDrawable pill = new android.graphics.drawable.GradientDrawable();
        pill.setColor(Color.argb(230, 0, 0, 0)); // Darker for high contrast
        pill.setCornerRadius(100f); 
        seekIndicator.setBackground(pill);
        
        android.widget.FrameLayout.LayoutParams seekParams = new android.widget.FrameLayout.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT);
        seekParams.gravity = android.view.Gravity.CENTER;
        seekIndicator.setLayoutParams(seekParams);
        seekIndicator.setVisibility(android.view.View.GONE);
        seekIndicator.setZ(999f); 
        playerView.addView(seekIndicator);

        dialog.setContentView(rootLayout);

        Window window = dialog.getWindow();
        if (window != null) {
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.MATCH_PARENT);
            window.setBackgroundDrawable(new ColorDrawable(Color.BLACK));
        }

        // ── HIGH-PERFORMANCE LoadControl ────────────────────────────────────────
        // bufferForPlaybackMs=3000: gives the demuxer time to find BOTH audio+video
        // track headers before playback begins → eliminates A/V desync.
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(
                        30_000, // minBufferMs — 30s
                        120_000, // maxBufferMs — 120s
                        3_000, // bufferForPlaybackMs 
                        5_000 // bufferForPlaybackAfterRebufferMs
                )
                .setTargetBufferBytes(100 * 1024 * 1024) // 100MB RAM Target to prevent progressive starvation
                .setPrioritizeTimeOverSizeThresholds(true)
                .build();

        // ── Hardware & Sync Fixes ───────────────────────────────────────────────
        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(getContext())
                .setEnableDecoderFallback(true) // Robustness: Allow software fallback
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON); // Prefer extensions if available

        DefaultTrackSelector trackSelector = new DefaultTrackSelector(getContext());
        // Explicitly disable tunneling and ensure we allow video joining without perfect headers
        trackSelector.setParameters(trackSelector.buildUponParameters()
            .setTunnelingEnabled(false)
            .setExceedRendererCapabilitiesIfNecessary(true)
        );

        // ── ExoPlayer ───────────────────────────────────────────────────────────
        player = new ExoPlayer.Builder(getContext())
                .setRenderersFactory(renderersFactory)
                .setTrackSelector(trackSelector)
                .setLoadControl(loadControl)
                .setSeekParameters(androidx.media3.exoplayer.SeekParameters.CLOSEST_SYNC)
                .setSeekForwardIncrementMs(seekStepMs)
                .setSeekBackIncrementMs(seekStepMs)
                .build();

        // Enforce strict 1.0x playback speed without pitch bending algorithms which can skew sync over time
        player.setPlaybackParameters(new PlaybackParameters(1.0f, 1.0f));

        player.addListener(new androidx.media3.common.Player.Listener() {
            @Override
            public void onPlayerError(androidx.media3.common.PlaybackException error) {
                Log.e(TAG, "[TELESTREAM_DEBUG] Player Error: " + error.getMessage() + " Code: " + error.errorCode);
                
                // Auto-Recovery for MKV/Resume "Black Screen" crash (Decoding Failed)
                if (error.errorCode == androidx.media3.common.PlaybackException.ERROR_CODE_DECODING_FAILED ||
                    error.errorCode == androidx.media3.common.PlaybackException.ERROR_CODE_DECODER_INIT_FAILED) {
                    
                    Log.w(TAG, "[TELESTREAM_DEBUG] Decoding failure detected. Attempting auto-recovery seek...");
                    long currentPos = player.getCurrentPosition();
                    player.prepare();
                    // Nudge back 1s to re-sync decoder
                    player.seekTo(Math.max(0, currentPos - 1000));
                    player.play();
                    return;
                }
                
                JSObject ret = new JSObject();
                ret.put("error", error.getMessage());
                emitEvent("player_error", ret);
                Log.e(TAG, "ExoPlayer Error: " + error.getMessage(), error);
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                String state = "UNKNOWN";
                android.view.View playPauseBtn = playerView.findViewById(androidx.media3.ui.R.id.exo_center_controls);
                if (playPauseBtn == null) playPauseBtn = playerView.findViewById(androidx.media3.ui.R.id.exo_play_pause);

                if (playbackState == androidx.media3.common.Player.STATE_BUFFERING) {
                    state = "BUFFERING";
                    if (playPauseBtn != null) playPauseBtn.setVisibility(android.view.View.INVISIBLE);
                } else {
                    if (playPauseBtn != null) playPauseBtn.setVisibility(android.view.View.VISIBLE);
                }

                if (playbackState == androidx.media3.common.Player.STATE_READY)
                    state = "READY";
                if (playbackState == androidx.media3.common.Player.STATE_ENDED) {
                    state = "ENDED";
                    // Notify JS that the video naturally finished.
                    // This is handled by a listener in index.html, not by playNextEpisode logic!
                    emitEvent("player_ended", new JSObject());
                }
                updateNativeDebug("PlaybackState: " + state);
            }
        });

        playerView.setPlayer(player);
        playerView.setUseController(true);
        playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS);
        playerView.requestFocus();

        // Apply TimeBar appearance IMMEDIATELY at open, not on first key press.
        // This ensures focus colors are correct from the very first user interaction.
        playerView.post(() -> {
            android.view.View timeBarView = playerView.findViewById(androidx.media3.ui.R.id.exo_progress);
            if (timeBarView instanceof androidx.media3.ui.DefaultTimeBar) {
                androidx.media3.ui.DefaultTimeBar dtb = (androidx.media3.ui.DefaultTimeBar) timeBarView;
                dtb.setKeyTimeIncrement(seekStepMs);
                // Default (unfocused) state: muted blue played bar, invisible scrubber
                dtb.setPlayedColor(Color.parseColor("#3B82F6"));
                dtb.setScrubberColor(Color.TRANSPARENT);
                dtb.setUnplayedColor(Color.argb(50, 255, 255, 255));

                timeBarView.setOnFocusChangeListener((v2, hasFocus) -> {
                    // Focused: white bar + visible white scrubber (Big Tech style)
                    dtb.setPlayedColor(hasFocus ? Color.WHITE : Color.parseColor("#3B82F6"));
                    dtb.setScrubberColor(hasFocus ? Color.WHITE : Color.TRANSPARENT);
                    dtb.setUnplayedColor(hasFocus ? Color.argb(100, 255, 255, 255) : Color.argb(50, 255, 255, 255));
                });
            }
        });

        // Toggle debug console
        playerView.setOnKeyListener((v, keyCode, event) -> {
            boolean isDown = event.getAction() == android.view.KeyEvent.ACTION_DOWN;
            if (isDown && (keyCode == android.view.KeyEvent.KEYCODE_DPAD_UP || keyCode == android.view.KeyEvent.KEYCODE_MENU)) {
                if (debugScrollView != null) {
                    int vis = debugScrollView.getVisibility() == android.view.View.VISIBLE ? android.view.View.GONE
                            : android.view.View.VISIBLE;
                    debugScrollView.setVisibility(vis);
                    return true;
                }
            }
            return false;
        });

        // Remote Controls and Back button behavior
        dialog.setOnKeyListener((dialogInterface, keyCode, event) -> {
            boolean isDown = event.getAction() == android.view.KeyEvent.ACTION_DOWN;
            boolean isUp = event.getAction() == android.view.KeyEvent.ACTION_UP;

            if (isDown && player != null) {
                if (!playerView.isControllerFullyVisible()) {
                    if (keyCode == android.view.KeyEvent.KEYCODE_DPAD_CENTER || keyCode == android.view.KeyEvent.KEYCODE_ENTER) {
                        player.setPlayWhenReady(!player.getPlayWhenReady());
                        playerView.showController();
                        return true;
                    } else if (keyCode == android.view.KeyEvent.KEYCODE_DPAD_LEFT || keyCode == android.view.KeyEvent.KEYCODE_DPAD_RIGHT) {
                        playerView.showController();
                        android.view.View timeBar = playerView.findViewById(androidx.media3.ui.R.id.exo_progress);
                        
                        // Seek Feedback Pop-up
                        if (seekIndicator != null) {
                            String direction = (keyCode == android.view.KeyEvent.KEYCODE_DPAD_LEFT) ? "« -" : "+ »";
                            seekIndicator.setText(direction + (seekStepMs / 1000) + "s");
                            
                            // Dynamic positioning based on direction
                            android.widget.FrameLayout.LayoutParams lp = (android.widget.FrameLayout.LayoutParams) seekIndicator.getLayoutParams();
                            if (keyCode == android.view.KeyEvent.KEYCODE_DPAD_LEFT) {
                                lp.gravity = android.view.Gravity.CENTER_VERTICAL | android.view.Gravity.LEFT;
                                lp.setMargins(120, 0, 0, 0);
                            } else {
                                lp.gravity = android.view.Gravity.CENTER_VERTICAL | android.view.Gravity.RIGHT;
                                lp.setMargins(0, 0, 120, 0);
                            }
                            seekIndicator.setLayoutParams(lp);

                            seekIndicator.setVisibility(android.view.View.VISIBLE);
                            seekIndicator.setAlpha(0f);
                            seekIndicator.setScaleX(0.7f);
                            seekIndicator.setScaleY(0.7f);
                            seekIndicator.animate().alpha(1f).scaleX(1.1f).scaleY(1.1f)
                                .setDuration(150).withEndAction(() -> {
                                    seekIndicator.animate().scaleX(1.0f).scaleY(1.0f).setDuration(100).start();
                                }).start();
                            seekIndicator.removeCallbacks(hideSeekIndicatorRunnable);
                            seekIndicator.postDelayed(hideSeekIndicatorRunnable, 1200);
                        }

                        if (timeBar != null) {
                            if (timeBar instanceof androidx.media3.ui.DefaultTimeBar) {
                                // Just ensure key increment is set with latest seekStepMs value
                                ((androidx.media3.ui.DefaultTimeBar) timeBar).setKeyTimeIncrement(seekStepMs);
                            }
                            timeBar.requestFocus();
                            timeBar.dispatchKeyEvent(event);
                        }
                        return true;
                    }
                }
            }

            if (isUp && keyCode == android.view.KeyEvent.KEYCODE_BACK) {
                if (playerView != null && playerView.isControllerFullyVisible()) {
                    playerView.hideController();
                    return true;
                }
            }
            return false;
        });

        // ── DataSource (Bridge + LocalFeedServer) ─────────────────────────
        currentBridgeDataSource = new BridgeDataSource(this, channel, messageId, fileSize);

        localFeedServer = new LocalFeedServer();
        localFeedServer.setActiveDataSource(currentBridgeDataSource);
        localFeedServer.start();

        // 🛑 REMOVED ExoCacheManager to prevent I/O disk bottlenecks on cheap TV eMMC flash drives!
        // Writing a multi-gigabyte video stream to disk while decoding causes fatal I/O stalls and A/V desync.
        androidx.media3.datasource.DataSource.Factory dataSourceFactory = () -> currentBridgeDataSource;

        MediaSource mediaSource = new ProgressiveMediaSource.Factory(dataSourceFactory)
                .createMediaSource(MediaItem.fromUri(currentBridgeDataSource.getUri()));

        // We use setMediaSource with the start position directly.
        // Secondary seek logic is removed as it often causes decoder hangups on hardware decoders.
        player.setMediaSource(mediaSource, seekTo); 
        player.prepare();
        player.play();
        
        player.setPlayWhenReady(true);

        // ── Dialog lifecycle ────────────────────────────────────────────────────
        final ExoPlayer thisPlayer = player;

        dialog.setOnDismissListener(d -> {
            Log.d(TAG, "dialog dismissed — releasing player (Session " + sessionId + ")");

            long currentPos = 0;
            long currentDur = 0;
            if (thisPlayer != null) {
                // Sanitize: ExoPlayer returns TIME_UNSET (-huge number) if not ready.
                // Clamping to 0 prevents garbage values in the database.
                currentPos = Math.max(0, thisPlayer.getCurrentPosition());
                currentDur = Math.max(0, thisPlayer.getDuration());
            }

            if (player == thisPlayer) {
                player = null;
            }
            if (thisPlayer != null) {
                thisPlayer.release();
            }

            // Only fire if it's the current session.
            if (sessionId == currentSessionId) {
                // ADB-Only Debug
                Log.d(TAG, "[TELESTREAM_DEBUG] Player closing. Session=" + sessionId + " Pos=" + currentPos + " Dur=" + currentDur);
                
                JSObject data = new JSObject();
                data.put("progress", currentPos);
                data.put("duration", currentDur);
                emitEvent("player_closed", data);
            }
        });

        dialog.show();
    }

    public void emitEvent(String eventName, JSObject data) {
        notifyListeners(eventName, data);
    }

    /** Helper for debugging on-screen. */
    public void emitDebug(String msg, String level) {
        JSObject data = new JSObject();
        data.put("msg", msg);
        data.put("level", level);
        emitEvent("debug_event", data);
    }

    /**
     * Minimal On-Demand HTTP Server to handle "Share Link from Phone".
     * Serves an embedded HTML page and accepts link submissions via POST.
     */
    private class ShareServer extends Thread {
        private final String token;
        private ServerSocket serverSocket;
        private boolean running = true;
        private final ExecutorService executor = Executors.newFixedThreadPool(2);

        public ShareServer(String token) {
            this.token = token;
        }

        public void stopServer() {
            running = false;
            try {
                if (serverSocket != null)
                    serverSocket.close();
            } catch (Exception ignored) {
            }
            executor.shutdownNow();
        }

        @Override
        public void run() {
            try {
                serverSocket = new ServerSocket(9991);
                Log.d(TAG, "ShareServer started on port 9991. Token=" + token);
                while (running) {
                    Socket client = serverSocket.accept();
                    executor.execute(() -> handleClient(client));
                }
            } catch (Exception e) {
                if (running)
                    Log.e(TAG, "ShareServer Error: " + e.getMessage());
            }
        }

        private void handleClient(Socket socket) {
            try (BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream()));
                    BufferedWriter out = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream()))) {

                String line = in.readLine();
                if (line == null)
                    return;

                String[] parts = line.split(" ");
                if (parts.length < 2)
                    return;

                String method = parts[0];
                String path = parts[1];

                int contentLength = 0;
                // Parse headers
                while ((line = in.readLine()) != null && !line.isEmpty()) {
                    if (line.toLowerCase().startsWith("content-length:")) {
                        contentLength = Integer.parseInt(line.substring(15).trim());
                    }
                }

                if (method.equals("OPTIONS")) {
                    sendResponse(out, 200, "text/plain", "");
                    return;
                }

                if (path.contains("favicon.ico")) {
                    sendResponse(out, 404, "text/plain", "");
                    return;
                }

                if (method.equals("GET") && path.startsWith("/share.html")) {
                    sendResponse(out, 200, "text/html", getShareHtml());
                } else if (method.equals("POST") && path.equals("/api/share/info")) {
                    StringBuilder bodyBuilder = new StringBuilder();
                    int totalRead = 0;
                    char[] buffer = new char[1024];
                    while (totalRead < contentLength) {
                        int read = in.read(buffer, 0, Math.min(buffer.length, contentLength - totalRead));
                        if (read == -1) break;
                        bodyBuilder.append(buffer, 0, read);
                        totalRead += read;
                    }
                    String payload = bodyBuilder.toString();
                    
                    if (payload.contains("\"token\":\"" + token + "\"")) {
                        String link = extractJsonValue(payload, "link");
                        String requestId = UUID.randomUUID().toString();
                        
                        CompletableFuture<JSObject> future = new CompletableFuture<>();
                        pendingMetadataRequests.put(requestId, future);
                        
                        // Trigger JS to resolve this
                        JSObject eventData = new JSObject();
                        eventData.put("requestId", requestId);
                        eventData.put("link", link);
                        if (StreamPlayerPlugin.this.bridge != null) {
                            StreamPlayerPlugin.this.bridge.triggerWindowJSEvent("need_metadata", eventData.toString());
                        }
                        
                        try {
                            // Wait for JS response (Max 10s)
                            JSObject meta = future.get(10, TimeUnit.SECONDS);
                            sendResponse(out, 200, "application/json", meta.toString());
                        } catch (Exception e) {
                            pendingMetadataRequests.remove(requestId);
                            sendResponse(out, 500, "application/json", "{\"error\":\"Timeout or error resolving metadata\"}");
                        }
                    } else {
                        sendResponse(out, 403, "application/json", "{\"error\":\"Invalid token\"}");
                    }
                } else if (method.equals("POST") && path.equals("/api/share/submit")) {
                    StringBuilder bodyBuilder = new StringBuilder();
                    int totalRead = 0;
                    char[] buffer = new char[1024];
                    while (totalRead < contentLength) {
                        int readCount = in.read(buffer, 0, Math.min(buffer.length, contentLength - totalRead));
                        if (readCount == -1) break;
                        bodyBuilder.append(buffer, 0, readCount);
                        totalRead += readCount;
                    }
                    String payload = bodyBuilder.toString();
                    
                    if (payload.contains("\"token\":\"" + token + "\"")) {
                        String link = extractJsonValue(payload, "link");
                        String name = extractJsonValue(payload, "name");
                        String type = extractJsonValue(payload, "type");

                        if (link != null) {
                            JSObject data = new JSObject();
                            data.put("link", link);
                            data.put("name", name);
                            data.put("type", type);
                            if (StreamPlayerPlugin.this.bridge != null) {
                                StreamPlayerPlugin.this.bridge.triggerWindowJSEvent("link_shared", data.toString());
                            }
                            sendResponse(out, 200, "application/json", "{\"success\":true}");
                        } else {
                            sendResponse(out, 400, "application/json", "{\"error\":\"Missing link\"}");
                        }
                    } else {
                        sendResponse(out, 403, "application/json", "{\"error\":\"Invalid token\"}");
                    }
                } else {
                    sendResponse(out, 404, "text/plain", "Not Found");
                }
            } catch (Exception e) {
                Log.e(TAG, "Socket Error: " + e.getMessage());
            } finally {
                try {
                    socket.close();
                } catch (Exception ignored) {
                }
            }
        }

        private String extractJsonValue(String json, String key) {
            String search = "\"" + key + "\":\"";
            int start = json.indexOf(search);
            if (start == -1) {
                // Try without quotes on key if needed, or with spaces
                search = "\"" + key + "\": \"";
                start = json.indexOf(search);
            }
            if (start == -1) return null;
            
            start += search.length();
            int end = json.indexOf("\"", start);
            if (end == -1) return null;
            
            return json.substring(start, end);
        }

        private void sendResponse(BufferedWriter out, int code, String type, String body) throws Exception {
            out.write("HTTP/1.1 " + code + (code == 200 ? " OK" : " Error") + "\r\n");
            out.write("Content-Type: " + type + "; charset=utf-8\r\n");
            out.write("Content-Length: " + body.getBytes("UTF-8").length + "\r\n");
            out.write("Access-Control-Allow-Origin: *\r\n");
            out.write("Connection: close\r\n");
            out.write("\r\n");
            out.write(body);
            out.flush();
        }

        private String getShareHtml() {
            return "<!DOCTYPE html><html lang=\"he\" dir=\"rtl\"><head>" +
                "<meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no\">" +
                "<title>TeleStream - שיתוף מקור</title>" +
                "<link href=\"https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700;800&display=swap\" rel=\"stylesheet\">" +
                "<style>" +
                ":root { --bg-base: #0B0C10; --accent: #3B82F6; --text-primary: #F8FAFC; --text-secondary: #94A3B8; --danger: #EF4444; --success: #22C55E; }" +
                "* { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Assistant', sans-serif; }" +
                "body { background: radial-gradient(circle at top, #1e293b 0%, var(--bg-base) 100%); color: var(--text-primary); min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 30px 20px; }" +
                ".container { width: 100%; max-width: 450px; display: flex; flex-direction: column; gap: 24px; }" +
                ".brand { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 20px; } .brand-icon { font-size: 2.5rem; } .brand-name { font-size: 1.8rem; font-weight: 800; background: linear-gradient(to left, #38bdf8, #818cf8); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }" +
                ".card { background: rgba(26, 28, 35, 0.8); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 24px; padding: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); display: none; animation: fadeIn 0.3s ease-out; }" +
                ".card.active { display: block; } @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }" +
                "h2 { font-size: 1.4rem; margin-bottom: 12px; font-weight: 700; text-align: center; } p { font-size: 0.95rem; color: var(--text-secondary); margin-bottom: 20px; text-align: center; line-height: 1.5; }" +
                ".instructions { background: rgba(59, 130, 246, 0.08); border-radius: 16px; padding: 16px; margin-bottom: 24px; text-align: right; }" +
                ".instruction-step { display: flex; gap: 12px; margin-bottom: 12px; font-size: 0.9rem; } .step-num { background: var(--accent); color: white; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 800; flex-shrink: 0; }" +
                ".styled-input { width: 100%; background: #0f172a; border: 2px solid #334155; color: white; border-radius: 14px; padding: 16px; font-size: 1rem; outline: none; transition: all 0.2s; margin-bottom: 16px; text-align: center; }" +
                ".styled-input:focus { border-color: var(--accent); box-shadow: 0 0 15px rgba(59, 130, 246, 0.3); }" +
                ".primary-btn { width: 100%; background: var(--accent); color: white; border: none; padding: 16px; border-radius: 14px; font-size: 1.1rem; font-weight: 700; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; }" +
                ".primary-btn:active { transform: scale(0.96); } .secondary-btn { width: 100%; background: transparent; color: var(--text-secondary); border: 1px solid #334155; padding: 14px; border-radius: 14px; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 12px; }" +
                ".type-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; } .type-card { background: #0f172a; border: 2px solid #334155; padding: 20px 10px; border-radius: 16px; text-align: center; cursor: pointer; transition: all 0.2s; } .type-card.active { border-color: var(--accent); background: rgba(59, 130, 246, 0.1); } .type-card .icon { font-size: 1.8rem; margin-bottom: 8px; display: block; } .type-card .label { font-size: 0.85rem; font-weight: 700; }" +
                ".loader { border: 4px solid rgba(255,255,255,0.1); border-top: 4px solid var(--accent); border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; } @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }" +
                ".error-msg { color: var(--danger); font-size: 0.9rem; margin-top: 10px; text-align: center; font-weight: 600; }" +
                "</style></head><body><div class=\"container\"><div class=\"brand\"><span class=\"brand-icon\">🎬</span><span class=\"brand-name\">TeleStream</span></div>" +
                "<div class=\"card active\" id=\"step-link\"><h2>הוספת מקור חדש</h2><p>שתף את התוכן מהנייד היישר לטלוויזיה שלך.</p><div class=\"instructions\"><div class=\"instruction-step\"><div class=\"step-num\">1</div><div>פתח את ערוץ הטלגרם המבוקש.</div></div><div class=\"instruction-step\"><div class=\"step-num\">2</div><div>לחץ <b>לחיצה ארוכה</b> על הודעה בערוץ.</div></div><div class=\"instruction-step\"><div class=\"step-num\">3</div><div>בחר ב-<b>Copy Link</b> (העתק קישור).</div></div><div class=\"instruction-step\"><div class=\"step-num\">4</div><div>הדבק את הקישור כאן למטה.</div></div></div><input type=\"url\" id=\"input-link\" class=\"styled-input\" placeholder=\"https://t.me/c/...\"><button class=\"primary-btn\" onclick=\"nextStep('meta')\">הממשך לשם המקור ➔</button><div id=\"error-link\" class=\"error-msg\" style=\"display:none;\">אנא הכנס קישור תקין</div></div>" +
                "<div class=\"card\" id=\"step-meta\"><div id=\"meta-fetching\" style=\"display:none;flex-direction:column;align-items:center;gap:16px;\"><div class=\"loader\"></div><p>מושך נתונים מהטלגרם...</p></div><div id=\"meta-content\" style=\"display:flex;flex-direction:column;align-items:center;width:100%;\"><h2>כיצד להציג את המקור?</h2><div id=\"meta-avatar-container\" style=\"margin-bottom:16px;\"></div><p>תן שם ברור למקור כדי שתוכל למצוא אותו בקלות בקטלוג.</p><input type=\"text\" id=\"input-name\" class=\"styled-input\" placeholder=\"שם הערוץ / הסדרה\"><button class=\"primary-btn\" onclick=\"nextStep('type')\">המשך לבחירת סוג ➔</button><button class=\"secondary-btn\" onclick=\"nextStep('link')\">חזור</button></div></div>" +
                "<div class=\"card\" id=\"step-type\"><h2>מה סוג התוכן?</h2><p>האם הערוץ מכיל סדרה אחת בלבד או אוסף של סרטים וסדרות?</p><div class=\"type-grid\"><div class=\"type-card\" id=\"type-single\" onclick=\"setType('single')\"><span class=\"icon\">🎬</span><span class=\"label\">סדרה אחת</span></div><div class=\"type-card\" id=\"type-multi\" onclick=\"setType('multi')\"><span class=\"icon\">📂</span><span class=\"label\">כמה סדרות (Multi)</span></div></div><button class=\"primary-btn\" id=\"send-btn\" onclick=\"submitToTv()\" style=\"margin-top:24px;\">שלח לטלוויזיה ✨</button><button class=\"secondary-btn\" onclick=\"nextStep('meta')\">חזור</button></div>" +
                "<div class=\"card\" id=\"step-status\"><div id=\"status-loading\" style=\"display:flex;flex-direction:column;align-items:center;gap:20px;\"><div class=\"loader\"></div><h2>שולח לטלוויזיה...</h2></div>" +
                "<div id=\"status-done\" style=\"display:none;flex-direction:column;align-items:center;gap:20px;color:var(--success);\"><span style=\"font-size:4rem;\">✅</span><h2>נשלח בהצלחה!</h2><p>הטלוויזיה שלך התחילה לעבוד. אתה יכול לסגור את העמוד.</p><button class=\"primary-btn\" onclick=\"window.location.reload()\">הוסף מקור נוסף</button></div>" +
                "<div id=\"status-error\" style=\"display:none;flex-direction:column;align-items:center;gap:20px;color:var(--danger);\"><span style=\"font-size:4rem;\">❌</span><h2>משהו השתבש</h2><p id=\"error-text\">לא הצלחנו להתחבר לטלוויזיה.</p><button class=\"primary-btn\" onclick=\"nextStep('type')\">נסה שוב</button></div></div></div>" +
                "<script>const params=new URLSearchParams(window.location.search);const token=params.get('token');let wizardData={link:'',name:'',type:'single'};" +
                "async function nextStep(s){if(s==='meta'){const l=document.getElementById('input-link').value.trim();if(!l||!l.includes('t.me/')){document.getElementById('error-link').style.display='block';return;}wizardData.link=l;document.getElementById('error-link').style.display='none';document.querySelectorAll('.card').forEach(c=>c.classList.remove('active'));document.getElementById('step-meta').classList.add('active');const f=document.getElementById('meta-fetching');const c=document.getElementById('meta-content');f.style.display='flex';c.style.display='none';try{const r=await fetch('/api/share/info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,link:wizardData.link})});const d=await r.json();f.style.display='none';c.style.display='flex';const n=document.getElementById('input-name');const a=document.getElementById('meta-avatar-container');if(d.success){n.value=d.title;if(d.photo)a.innerHTML=`<img src=\"${d.photo}\" style=\"width:80px;height:80px;border-radius:50%;border:3px solid var(--accent);object-fit:cover;\">`;else a.innerHTML='<div style=\"font-size:3rem;\">📡</div>';}else{const p=l.split('/');n.value=p[p.length-1]||p[p.length-2];a.innerHTML='<div style=\"font-size:3rem;\">📡</div>';}}catch(e){f.style.display='none';c.style.display='flex';const p=l.split('/');document.getElementById('input-name').value=p[p.length-1]||p[p.length-2];}return;}if(s==='type'){wizardData.name=document.getElementById('input-name').value.trim()||wizardData.link;}document.querySelectorAll('.card').forEach(c=>c.classList.remove('active'));document.getElementById('step-'+s).classList.add('active');}" +
                "function setType(t){wizardData.type=t;document.getElementById('type-single').classList.toggle('active',t==='single');document.getElementById('type-multi').classList.toggle('active',t==='multi');}async function submitToTv(){if(!token){alert('טוקן לא תקין.');return;}nextStep('status');document.getElementById('status-loading').style.display='flex';document.getElementById('status-done').style.display='none';document.getElementById('status-error').style.display='none';try{const r=await fetch('/api/share/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,link:wizardData.link,name:wizardData.name,type:wizardData.type})});const d=await r.json();if(d.success){document.getElementById('status-loading').style.display='none';document.getElementById('status-done').style.display='flex';}else{throw new Error(d.error||'שגיאת שרת');}}catch(e){document.getElementById('status-loading').style.display='none';document.getElementById('status-error').style.display='flex';document.getElementById('error-text').innerText=e.message;}}setType('single');</script></body></html>";
        }
    }
}

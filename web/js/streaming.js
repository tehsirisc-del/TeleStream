/**
 * Video Streaming — Optimized Native Capacitor Bridge
 * Fixed for exact lifecycle management, transition locks, and abort loops.
 */

const Streaming = (() => {
  let isStreaming = false;
  
  // Track active file details mapped by messageId, so old requests don't bleed
  let activeStreamSession = null; 
  
  // Transition lock
  let streamTransitionLock = false;

  let listenersAttached = false;
  let currentRequestId = -1;
  let activeAbortFlag = { aborted: false };


  async function attachBridgeListenersOnce() {
    if (listenersAttached) return true;

    if (!window.Capacitor || !window.Capacitor.Plugins.StreamPlayer) {
      console.warn('[Streaming] StreamPlayer plugin not found.');
      return false;
    }

    const { StreamPlayer } = window.Capacitor.Plugins;

    // Clean old listeners just in case of hot-reload or previous bad state
    try { await StreamPlayer.removeAllListeners(); } catch(_) {}

    await StreamPlayer.addListener('debug_event', (d) => {
      if (window.appLog) window.appLog(`[NATIVE] ${d.msg}`, d.level === 'error' ? '#ef4444' : '#eab308');
    });

    await StreamPlayer.addListener('player_closed', async (data) => {
      console.log('[Streaming] player_closed event received.', data);
      // The user naturally closed the player via Android TV remote Back button.
      // We must completely release the lock and clean up.
      await stopAndCleanUp();
      if (window.syncProgressNow) window.syncProgressNow(false, data.progress, data.duration);
      if (window.closePlayerUIOnly) window.closePlayerUIOnly();
    });

    // Handle new chunks request when player starts or seeks
    await StreamPlayer.addListener('request_chunk', async (data) => {
      const { offset, length, messageId, channel, requestId } = data;

      // Ensure this request is for the CURRENT active session
      if (!isStreaming || !activeStreamSession) {
          console.warn(`[Streaming] Ignored request_chunk for ${messageId} — no active session.`);
          return;
      }
      
      if (String(activeStreamSession.messageId) !== String(messageId)) {
          console.warn(`[Streaming] Dropping stale request_chunk (req:${messageId} vs active:${activeStreamSession.messageId})`);
          // Send EOF to Java immediately to unblock it
          try { fetch(`http://127.0.0.1:9992/feed?reqId=${requestId}`, { method: 'POST', body: new Uint8Array(0) }).catch(()=>{}); } catch(e){}
          return;
      }

      // ── MIGHTY ABORT SIGNAL ──
      activeAbortFlag.aborted = true;
      const myAbortFlag = { aborted: false };
      activeAbortFlag = myAbortFlag;

      currentRequestId = String(requestId);
      const myReqId = String(requestId);

      if (window.appLog) await window.appLog(`[Bridge] HTTP Local Stream: offset=${offset}`, '#38bdf8');

      try {
        const { Api } = window.TelegramModule || require('telegram');
        const fileLoc = new Api.InputDocumentFileLocation({
          id: activeStreamSession.document.id,
          accessHash: activeStreamSession.document.accessHash,
          fileReference: activeStreamSession.document.fileReference,
          thumbSize: ''
        });

        const BLOCK_SIZE = 1024 * 1024; // 1MB chunk reads for higher throughput
        let currentOffset = offset;
        let runningLimit = length > 0 ? length : undefined;
        let retryCount = 0;
        const MAX_RETRIES = 5;

        // Resilient loop: downloads chunks and transparently reconnects on Telegram timeouts.
        while (currentOffset < (length > 0 ? (offset + length) : Infinity)) {
            if (myAbortFlag.aborted || myReqId !== currentRequestId || !isStreaming) break;

            const alignedOffset = Math.floor(currentOffset / BLOCK_SIZE) * BLOCK_SIZE;
            let bytesToDiscard = currentOffset - alignedOffset;
            
            const iterOptions = {
              file: fileLoc,
              offset: window.bigInt ? window.bigInt(alignedOffset) : alignedOffset,
              limit: runningLimit ? runningLimit + bytesToDiscard : undefined,
              requestSize: Math.min(BLOCK_SIZE, 1024 * 1024),
              workers: 2, 
              dcId: activeStreamSession.document.dcId || undefined
            };

            try {
                const iter = window.TGClient.iterDownload(iterOptions);
                if (activeStreamSession) activeStreamSession.activeIter = iter;

                for await (const chunk of iter) {
                    // Safety check at start of every chunk
                    if (myAbortFlag.aborted || myReqId !== currentRequestId || !isStreaming) {
                        throw new Error("ABORTED_BY_NEW_REQUEST");
                    }

                    let arr = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                    if (bytesToDiscard > 0) {
                        if (arr.length <= bytesToDiscard) {
                            bytesToDiscard -= arr.length;
                            continue; 
                        } else {
                            arr = arr.slice(bytesToDiscard);
                            bytesToDiscard = 0;
                        }
                    }

                    // Push binary array to native loopback server
                    let accepted = false;
                    while (!accepted) {
                        if (myAbortFlag.aborted || myReqId !== currentRequestId || !isStreaming) {
                            throw new Error("ABORTED_BY_NEW_REQUEST");
                        }
                        try {
                            const res = await fetch(`http://127.0.0.1:9992/feed?reqId=${myReqId}&offset=${currentOffset}`, {
                                method: 'POST',
                                body: arr
                            });
                            accepted = res.ok;
                        } catch (err) {
                            accepted = false; 
                        }
                        if (!accepted) { 
                            await new Promise(r => setTimeout(r, 100));
                        }
                    }
                    
                    currentOffset += arr.length;
                    if (runningLimit) runningLimit -= arr.length;
                    
                    // Reset retry on successful chunk incoming
                    retryCount = 0;

                    if (runningLimit <= 0) break;
                } // end for await
                
                // Natural EOF or reached limit
                break;
                
            } catch (iterErr) {
                if (iterErr.message === "ABORTED_BY_NEW_REQUEST" || myAbortFlag.aborted || myReqId !== currentRequestId) {
                    throw new Error("ABORTED_BY_NEW_REQUEST");
                }
                
                retryCount++;
                if (retryCount > MAX_RETRIES) {
                    throw new Error(`Telegram stream failed after ${MAX_RETRIES} retries: ${iterErr.message}`);
                }

                // Telegram dropped connection. Catch it and retry with exponential backoff.
                const backoff = Math.min(1000 * Math.pow(2, retryCount - 1), 5000);
                console.warn(`[Streaming] Telegram retry ${retryCount}/${MAX_RETRIES} in ${backoff}ms at offset ${currentOffset}. Msg: ${iterErr.message}`);
                
                if (window.appLog) window.appLog(`[Bridge] Link dropped. Retry ${retryCount}/${MAX_RETRIES}...`, '#f59e0b');
                await new Promise(r => setTimeout(r, backoff));
            }
        } // end while

        // Send EOF signal gracefully
        if (!myAbortFlag.aborted && myReqId === currentRequestId && isStreaming) {
            try { fetch(`http://127.0.0.1:9992/feed?reqId=${myReqId}`, { method: 'POST', body: new Uint8Array(0) }).catch(()=>{}); } catch(e){}
        }

      } catch (err) {
        if (err.message !== "ABORTED_BY_NEW_REQUEST") {
            console.error('[Streaming] iterDownload top-level error:', err);
            if (window.appLog) await window.appLog(`[Bridge] ERROR: ${err.message}`, '#ef4444');
        } else {
            console.log(`[Streaming] Clean abort of request ${myReqId}`);
        }
      }
    });

    await StreamPlayer.addListener('stop_chunk', () => {
      console.log('[Streaming] stop_chunk event received.');
      activeAbortFlag.aborted = true;
    });

    listenersAttached = true;
    console.log('[Streaming] HTTPS Bridge listeners globally attached exactly once.');
    return true;
  }

  // Kill the active download session ONLY. Never touches streamTransitionLock.
  // Called when: player_closed fires, episode switches, explicit stop.
  async function killActiveSession() {
    activeAbortFlag.aborted = true;
    activeAbortFlag = { aborted: false };
    isStreaming = false;
    currentRequestId = -1;
    if (activeStreamSession && activeStreamSession.activeIter) {
        try { await activeStreamSession.activeIter.return(); } catch(e) {}
    }
    activeStreamSession = null;
  }

  // Full cleanup: kills session AND releases the transition lock.
  // Called from: user explicitly pressed BACK natively (player_closed) or via web (closePlayer)
  async function stopAndCleanUp() {
    await killActiveSession();
    streamTransitionLock = false; 
  }

  async function streamToVideo(videoEl, message, mimeType, onStatus, seekStep = 15) {
    if (streamTransitionLock) {
        console.warn("[Streaming] Ignored play request: transition already in progress.");
        return;
    }

    // Acquire the lock. It will NOT be released until stopAndCleanUp() is called
    // (i.e., the user presses BACK). Never released by player_closed or retries.
    streamTransitionLock = true;

    // Kill previous download session only (not the lock itself)
    await killActiveSession();

    isStreaming = true;

    const doc = message.media?.document || message.document || message;
    if (!doc) {
        await stopAndCleanUp(); // releases lock on setup error
        throw new Error('No document in message');
    }

    if (window.showToast) window.showToast('Connecting to Telegram Stream...', 'info');

    activeStreamSession = {
        messageId: message.id.toString(),
        document: doc,
        totalSize: Number(doc.size),
        activeIter: null
    };

    const bridgeOK = await attachBridgeListenersOnce();
    if (!bridgeOK) {
        if (onStatus) onStatus({ error: 'Plugin not connected.' });
        await stopAndCleanUp(); // releases lock on setup error
        return;
    }

    const { StreamPlayer } = window.Capacitor.Plugins;
    let title = 'Unknown Title';
    for (const attr of (doc.attributes || [])) {
        if (attr.className === 'DocumentAttributeFilename') title = attr.fileName;
    }

    const peerId = message.peerId || {};
    const channelStr = (peerId.channelId || peerId.userId || peerId.chatId || 'unknown').toString();

    if (onStatus) onStatus({ mode: 'Local Binary Stream' });

    try {
        await StreamPlayer.play({
            messageId: activeStreamSession.messageId,
            channel: channelStr,
            title,
            fileSize: activeStreamSession.totalSize,
            progress: window.currentEpProgress || 0,
            seekStep: seekStep
        });
        // Lock remains held — Java ExoPlayer is now running.
        // It will only be released when the user closes the player (stopAndCleanUp).
    } catch (err) {
        console.error('[Streaming] play() failed:', err);
        if (onStatus) onStatus({ error: err.message });
        await stopAndCleanUp(); // releases lock on Java error
    }
  }

  // Public API
  return {
      streamToVideo,
      // Called ONLY when user explicitly closes the player (BACK button).
      // This is the ONLY place that releases streamTransitionLock.
      stop: async () => {
          await stopAndCleanUp();
      },
      isTransitioning: () => streamTransitionLock
  };
})();

window.Streaming = Streaming;

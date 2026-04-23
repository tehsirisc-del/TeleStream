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

  const isAndroidNative = !!(window.Capacitor && /Android/i.test(navigator.userAgent || ''));
  const isLeanDevice = isAndroidNative && ((navigator.hardwareConcurrency || 4) <= 4);
  const TELEGRAM_WORKERS = isAndroidNative ? (isLeanDevice ? 2 : 3) : 2;
  const TELEGRAM_READ_SIZE = 1024 * 1024;
  const POST_BATCH_SIZE = isLeanDevice ? 512 * 1024 : 1024 * 1024;
  const MAX_BATCH_WAIT_MS = isLeanDevice ? 150 : 100;

  function buildTelegramMessageLink(sourceLink, messageId) {
    if (!sourceLink || !messageId) return null;

    try {
      const url = new URL(sourceLink);
      const parts = url.pathname.split('/').filter(Boolean);
      if (!parts.length) return null;

      if (parts[0] === 'c' && parts.length >= 2) {
        return `https://t.me/c/${parts[1]}/${messageId}`;
      }

      return `https://t.me/${parts[0]}/${messageId}`;
    } catch (_) {
      return null;
    }
  }

  async function postChunk(reqId, offset, body, abortFlag) {
    while (true) {
      if (abortFlag.aborted || String(reqId) !== currentRequestId || !isStreaming) {
        throw new Error("ABORTED_BY_NEW_REQUEST");
      }

      try {
        const res = await fetch(`http://127.0.0.1:9992/feed?reqId=${reqId}&offset=${offset}`, {
          method: 'POST',
          body
        });
        if (res.ok) return;
      } catch (_) {}

      await new Promise(r => setTimeout(r, 100));
    }
  }

  async function flushBufferedParts(reqId, startOffset, parts, totalLength, abortFlag) {
    if (!totalLength) return startOffset;

    const merged = new Uint8Array(totalLength);
    let writeOffset = 0;
    for (const part of parts) {
      merged.set(part, writeOffset);
      writeOffset += part.length;
    }

    await postChunk(reqId, startOffset, merged, abortFlag);
    return startOffset + totalLength;
  }


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

      if (window.nativeDebugEnabled && window.appLog) {
        window.appLog(`[Bridge] Stream request offset=${offset}`, '#38bdf8');
      }

      try {
        const { Api } = window.TelegramModule || require('telegram');
        const fileLoc = new Api.InputDocumentFileLocation({
          id: activeStreamSession.document.id,
          accessHash: activeStreamSession.document.accessHash,
          fileReference: activeStreamSession.document.fileReference,
          thumbSize: ''
        });

        const BLOCK_SIZE = TELEGRAM_READ_SIZE;
        let currentOffset = offset;
        let runningLimit = length > 0 ? length : undefined;
        let retryCount = 0;
        const MAX_RETRIES = 5;
        let pendingParts = [];
        let pendingBytes = 0;
        let pendingOffset = currentOffset;
        let pendingSince = 0;

        // Resilient loop: downloads chunks and transparently reconnects on Telegram timeouts.
        while (currentOffset < (length > 0 ? (offset + length) : Infinity)) {
            if (myAbortFlag.aborted || myReqId !== currentRequestId || !isStreaming) break;

            const alignedOffset = Math.floor(currentOffset / BLOCK_SIZE) * BLOCK_SIZE;
            let bytesToDiscard = currentOffset - alignedOffset;
            
            const iterOptions = {
              file: fileLoc,
              offset: window.bigInt ? window.bigInt(alignedOffset) : alignedOffset,
              limit: runningLimit ? runningLimit + bytesToDiscard : undefined,
              requestSize: BLOCK_SIZE,
              workers: TELEGRAM_WORKERS,
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

                    if (!pendingBytes) {
                        pendingOffset = currentOffset;
                        pendingSince = Date.now();
                    }

                    pendingParts.push(arr);
                    pendingBytes += arr.length;

                    if (pendingBytes >= POST_BATCH_SIZE || (Date.now() - pendingSince) >= MAX_BATCH_WAIT_MS) {
                        currentOffset = await flushBufferedParts(myReqId, pendingOffset, pendingParts, pendingBytes, myAbortFlag);
                        if (runningLimit) runningLimit -= pendingBytes;
                        pendingParts = [];
                        pendingBytes = 0;
                        pendingSince = 0;
                    }
                    
                    // Reset retry on successful chunk incoming
                    retryCount = 0;

                    if (runningLimit !== undefined && runningLimit <= 0) break;
                } // end for await

                if (pendingBytes > 0) {
                    currentOffset = await flushBufferedParts(myReqId, pendingOffset, pendingParts, pendingBytes, myAbortFlag);
                    if (runningLimit) runningLimit -= pendingBytes;
                    pendingParts = [];
                    pendingBytes = 0;
                    pendingSince = 0;
                }
                
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
                
                if (window.nativeDebugEnabled && window.appLog) {
                  window.appLog(`[Bridge] Link retry ${retryCount}/${MAX_RETRIES}`, '#f59e0b');
                }
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
            if (window.appLog) await window.appLog(`[Bridge] ERROR: ${err.message}`, '#ef4444', 'error');
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
    const peerType = peerId.channelId ? 'channel' : (peerId.userId ? 'user' : 'chat');
    const channelStr = (peerId.channelId || peerId.userId || peerId.chatId || 'unknown').toString();
    const source = message.sourceId ? await window.DB.getSourceById(message.sourceId) : null;
    const messageLink = buildTelegramMessageLink(source?.link, activeStreamSession.messageId);

    if (onStatus) onStatus({ mode: 'Local Binary Stream' });

    try {
        await StreamPlayer.play({
            messageId: activeStreamSession.messageId,
            peerType,
            channel: channelStr,
            messageLink,
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

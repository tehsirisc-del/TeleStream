/**
 * GramJS Telegram Client — Browser Mode
 * Handles authentication (QR + phone), entity resolution, indexing downloads.
 * Session persisted in localStorage.
 */

// ── Config (embedded at build time via .env) ─────────────────────────
const TG_API_ID = parseInt(window.TG_API_ID);
const TG_API_HASH = window.TG_API_HASH;

if (!TG_API_ID || !TG_API_HASH) {
  console.error('[TelegramClient] FATAL: API credentials not loaded from config.js!');
}
const SESSION_KEY = 'tg_session';

let client = null;
let isAuthed = false;
let currentUserId = null;

let qrLink = null;
let qrError = null;
let phoneCodeResolve = null;
let phonePassResolve = null;
let phoneAuthState = 'idle';
let phoneAuthError = null;

async function initClient() {
  const { TelegramClient } = TelegramModule;
  const { StringSession } = TelegramModule.sessions;

  const sessionStr = localStorage.getItem(SESSION_KEY) || '';
  const session = new StringSession(sessionStr);

  client = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
    connectionRetries: 10,
    retryDelay: 1000,
    autoReconnect: true,
    downloadRetries: 5,
    useWSS: true, // MUST be true in browser
    testMode: false
  });

  try {
    // Add a race condition to prevent infinite hang on connect()
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Telegram Connection Timeout")), 15000))
    ]);
  } catch (e) {
    console.error("[TelegramClient] Connection failed:", e.message);
    if (e.message && e.message.includes("FLOOD_WAIT")) {
      const seconds = e.message.match(/\d+/);
      const waitTime = seconds ? seconds[0] : "unknown";
      throw new Error(`Telegram Flood Ban: Please wait ${waitTime} seconds before trying again.`);
    }
    throw e;
  }
  return client;
}

async function checkExistingSession() {
  try {
    const me = await client.getMe();
    if (me) {
      isAuthed = true;
      currentUserId = me.id.toString();
      return true;
    }
  } catch (e) {
    console.error("[TelegramClient] checkExistingSession error:", e.message);
    
    // Normalize error message
    const msg = (e.message || "").toUpperCase();
    
    // If we get an explicit "User deauthorized" or "Session revoked" error, we return false
    const isAuthError = msg.includes("AUTH_KEY_INVALID") || 
                        msg.includes("AUTH_KEY_UNREGISTERED") ||
                        msg.includes("USER_DEACTIVATED") || 
                        msg.includes("SESSION_REVOKED") ||
                        msg.includes("SESSION_EXPIRED");

    if (isAuthError) {
      console.warn("[TelegramClient] Session is invalid, clearing localStorage.");
      localStorage.removeItem(SESSION_KEY);
      return false;
    }
    
    if (msg.includes("FLOOD_WAIT")) {
      const seconds = msg.match(/\d+/);
      throw new Error(`Telegram Flood Ban: Please wait ${seconds ? seconds[0] : 'some'} seconds.`);
    }
    // For other errors, re-throw so startApp can show the error
    throw e;
  }
  return false;
}

function saveSession() {
  const sess = client.session.save();
  localStorage.setItem(SESSION_KEY, sess);
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function decodeBase64UrlToBytes(input) {
  if (!input) throw new Error('Missing native login token');

  let normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  if (padding) {
    normalized += '='.repeat(4 - padding);
  }

  const raw = atob(normalized);
  const gramHelpers = TelegramModule?.helpers;
  if (gramHelpers?.generateRandomBytes) {
    const buffer = gramHelpers.generateRandomBytes(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      buffer[i] = raw.charCodeAt(i) & 0xff;
    }
    return buffer;
  }

  // Fallback path for environments where the GramJS Buffer helper is unavailable.
  return raw;
}

// ── QR Auth ──────────────────────────────────────────────────────────

function startQrLogin(onQrCode, onSuccess, onError) {
  qrLink = null;
  qrError = null;

  client.signInUserWithQrCode(
    { apiId: TG_API_ID, apiHash: TG_API_HASH },
    {
      qrCode: (code) => {
        const tokenB64 = btoa(String.fromCharCode(...code.token));
        qrLink = `tg://login?token=${tokenB64}`;
        onQrCode(qrLink);
      },
      onError: (err) => {
        qrError = err.message;
        if (onError) onError(err.message);
      },
      password: async () => {
        qrError = '2FA required. Use Phone Login instead.';
        if (onError) onError(qrError);
        return '';
      }
    }
  ).then(async () => {
    isAuthed = true;
    saveSession();
    const me = await client.getMe();
    currentUserId = me.id.toString();
    if (onSuccess) onSuccess(currentUserId);
  }).catch(e => {
    qrError = e.message;
    if (onError) onError(e.message);
  });
}

// ── Phone Auth ────────────────────────────────────────────────────────

function startPhoneLogin(phone, onState, onSuccess, onError) {
  phoneAuthState = 'working';
  phoneAuthError = null;

  client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => {
      phoneAuthState = 'wait_code';
      onState(phoneAuthState);
      return new Promise(r => { phoneCodeResolve = r; });
    },
    password: async () => {
      phoneAuthState = 'wait_password';
      onState(phoneAuthState);
      return new Promise(r => { phonePassResolve = r; });
    },
    onError: (err) => {
      phoneAuthError = err.message;
      if (phoneAuthError.includes('PHONE_NUMBER_INVALID')) phoneAuthError = 'Invalid phone number format.';
      else if (phoneAuthError.includes('PHONE_CODE_INVALID')) phoneAuthError = 'The code you entered is invalid.';
      else if (phoneAuthError.includes('PHONE_CODE_EXPIRED')) phoneAuthError = 'The code has expired. Please resend.';
      else if (phoneAuthError.includes('FLOOD_WAIT')) {
          const seconds = phoneAuthError.match(/\d+/) || 'some';
          phoneAuthError = `Too many attempts. Please wait ${seconds} seconds.`;
      }
      
      phoneAuthState = 'error';
      if (onError) onError(phoneAuthError);
    }
  }).then(async () => {
    isAuthed = true;
    phoneAuthState = 'success';
    saveSession();
    const me = await client.getMe();
    currentUserId = me.id.toString();
    if (onSuccess) onSuccess(currentUserId);
  }).catch(e => {
    phoneAuthState = 'error';
    phoneAuthError = e.message;
    if (phoneAuthError.includes('PHONE_NUMBER_INVALID')) phoneAuthError = 'Invalid phone number format.';
    else if (phoneAuthError.includes('PHONE_CODE_INVALID')) phoneAuthError = 'The code you entered is invalid.';
    
    if (onError) onError(phoneAuthError);
  });
}

function submitPhoneCode(code) {
  if (phoneCodeResolve) {
    phoneCodeResolve(code);
    phoneCodeResolve = null;
  }
}

function submitPassword(pass) {
  if (phonePassResolve) {
    phonePassResolve(pass);
    phonePassResolve = null;
  }
}

// ── Dialogs & Entities ────────────────────────────────────────────────

async function getDialogs() {
  return client.getDialogs({ limit: 50 });
}

async function getEntity(channelArg) {
  return client.getEntity(channelArg);
}

async function resolveChannelFromLink(link) {
  const url = new URL(link);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'c') {
    const fullId = '-100' + parts[1];
    return { channelName: fullId, channelArg: window.bigInt(fullId) };
  } else {
    return { channelName: parts[0], channelArg: parts[0] };
  }
}

// ── Indexing messages ─────────────────────────────────────────────────

async function* iterMessages(channelArg, { limit = 100, offsetId = 0, filter } = {}) {
  const msgs = await client.getMessages(channelArg, { limit, offsetId, filter });
  for (const m of msgs) yield m;
}

async function getMessages(channelArg, options) {
  return client.getMessages(channelArg, options);
}

const SYNC_CHANNEL_NAME = 'StreamApp Data';
const SYNC_SCRAMBLE_KEY = 'TeleStreamSyncKey!#2024';

let cachedSyncChannelId = null;

/**
 * scramble(text)
 * Simple XOR obfuscation to keep sync data private in the Telegram channel.
 */
function scrambleSyncData(str) {
  try {
    const utf8 = unescape(encodeURIComponent(str));
    let result = '';
    for (let i = 0; i < utf8.length; i++) {
      result += String.fromCharCode(utf8.charCodeAt(i) ^ SYNC_SCRAMBLE_KEY.charCodeAt(i % SYNC_SCRAMBLE_KEY.length));
    }
    return btoa(result);
  } catch (e) {
    console.error('[Sync] Scramble failed:', e);
    return btoa(str); // Fallback to raw base64 if failed
  }
}

/**
 * unscramble(b64)
 */
function unscrambleSyncData(b64) {
  try {
    const raw = atob(b64.replace(/[\n\r\s]/g, ''));
    let result = '';
    for (let i = 0; i < raw.length; i++) {
      result += String.fromCharCode(raw.charCodeAt(i) ^ SYNC_SCRAMBLE_KEY.charCodeAt(i % SYNC_SCRAMBLE_KEY.length));
    }
    return decodeURIComponent(escape(result));
  } catch (e) {
    // If unscramble fails (e.g. legacy non-scrambled data), try raw atob as fallback
    try {
        const raw = atob(b64.replace(/[\n\r\s]/g, ''));
        return decodeURIComponent(escape(raw));
    } catch(e2) {
        return null;
    }
  }
}

/**
 * ensureSyncChannel()
 * Returns the peer ID of the sync channel, creating it if necessary.
 */
async function ensureSyncChannel() {
  if (cachedSyncChannelId) return cachedSyncChannelId;

  const dialogs = await client.getDialogs({ limit: 100 });
  // Search by title OR by the entity if title fails (sometimes dialogs have empty titles but entities have titles)
  let syncChannel = dialogs.find(d => {
    const title = d.title || d.entity?.title;
    return title === SYNC_CHANNEL_NAME && (d.isChannel || d.isGroup || d.entity?.className === 'Channel' || d.entity?.className === 'Chat');
  });

  if (!syncChannel) {
    console.log('[Sync] Creating storage channel...');
    const { Api } = TelegramModule;
    try {
      const result = await client.invoke(new Api.channels.CreateChannel({
        title: SYNC_CHANNEL_NAME,
        about: 'Private storage for TeleStream synchronizations.',
        broadcast: true
      }));
      cachedSyncChannelId = result.chats[0].id.toString();
    } catch (e) {
      console.error('[Sync] Channel creation failed:', e);
      return null;
    }
  } else {
    cachedSyncChannelId = (syncChannel.entity?.id || syncChannel.id).toString();
  }
  return cachedSyncChannelId;
}

/**
 * pushSyncData(tag, payload)
 * Edits or sends a message with the given tag (e.g. #StreamAppProgress)
 */
async function pushSyncData(tag, payload) {
  try {
    const channelPeer = await ensureSyncChannel();
    if (!channelPeer) return;

    const json = JSON.stringify(payload);
    // Apply privacy scrambling
    const scrambled = scrambleSyncData(json);
    const messageText = `${tag}\n${scrambled}`;

    // Look deep to find existing tags so we don't leave zombie duplicates when pushing new data
    const messages = await client.getMessages(channelPeer, { limit: 500 });
    const existing = messages.find(m => m.message && m.message.startsWith(tag));

    if (existing) {
      // Deleting and re-sending ensures the metadata "bubbles" to the top of the history.
      // Editing would keep it buried, potentially beyond the pullSyncData search limit.
      await client.deleteMessages(channelPeer, [existing.id], { revoke: true });
    }
    await client.sendMessage(channelPeer, { message: messageText });
    console.log(`[Sync] Pushed ${tag} (New message at top)`);
  } catch (e) {
    console.error(`[Sync] Push failed for ${tag}:`, e.message);
  }
}

/**
 * pullSyncData(tag)
 * Returns the parsed JSON payload for a specific tag.
 */
async function pullSyncData(tag) {
  try {
    const channelPeer = await ensureSyncChannel();
    if (!channelPeer) return null;

    // Deep Sync: Increase lookback tremendously (500) to ensure we don't miss tags buried under progress updates
    const messages = await client.getMessages(channelPeer, { limit: 500 });
    const msg = messages.find(m => m.message && m.message.includes(tag));
    if (!msg) return null;

    const text = msg.message;
    const tagIdx = text.indexOf(tag);
    const dataStr = text.substring(tagIdx + tag.length).trim();
    if (!dataStr) return null;

    // Apply unscrambling
    const jsonStr = unscrambleSyncData(dataStr);
    if (!jsonStr) return null;
    
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error(`[Sync] Pull failed for ${tag}:`, e.message);
    return null;
  }
}

// ── Photo download ─────────────────────────────────────────────────────

async function downloadProfilePhoto(entity) {
  try {
    const buf = await client.downloadProfilePhoto(entity, { isBig: false });
    if (buf && buf.length > 0) {
      const base64 = btoa(String.fromCharCode(...buf));
      return `data:image/jpeg;base64,${base64}`;
    }
  } catch (e) {}
  return null;
}

// ── iterDownload (for streaming) ──────────────────────────────────────

function iterDownload(options) {
  return client.iterDownload(options);
}

// ── Message metadata ──────────────────────────────────────────────────

const messageMetaCache = new Map();

async function getMessageMeta(channelArg, messageId) {
  const key = `${channelArg}_${messageId}`;
  if (messageMetaCache.has(key)) return messageMetaCache.get(key);

  const msgs = await client.getMessages(channelArg, { ids: [messageId] });
  if (!msgs || msgs.length === 0 || !msgs[0].media) return null;

  const msg = msgs[0];
  const doc = msg.media.document;
  if (!doc) return null;

  const meta = { message: msg, document: doc, fileSize: Number(doc.size), mimeType: doc.mimeType || 'video/mp4' };
  messageMetaCache.set(key, meta);
  return meta;
}

function decodeLoginTokenBytes(loginLink) {
  const url = new URL(loginLink);
  const tokenB64 = url.searchParams.get('token');
  return decodeBase64UrlToBytes(tokenB64);
}

async function nativeDebugLog(message, level = 'd') {
  try {
    const nativePlugin = window.Capacitor?.Plugins?.TelegramNative;
    if (!nativePlugin) return;
    await nativePlugin.debugLog({ level, message });
  } catch (_) {
    // Intentionally ignore logging failures.
  }
}

function isRetryableNativeTokenError(errorMessage) {
  return typeof errorMessage === 'string' &&
    (errorMessage.includes('AUTH_TOKEN_EXPIRED') || errorMessage.includes('AUTH_TOKEN_INVALID'));
}

async function acceptNativeLoginToken(qrLink, attemptLabel = 'initial') {
  const { Api } = TelegramModule;
  await nativeDebugLog(`accept token attempt=${attemptLabel} hasCtor=${!!Api?.auth?.AcceptLoginToken}`);
  const token = decodeLoginTokenBytes(qrLink);
  await nativeDebugLog(`token decoded attempt=${attemptLabel} length=${token.length} ctor=${token.constructor?.name}`);
  const acceptResult = await client.invoke(new Api.auth.AcceptLoginToken({ token }));
  await nativeDebugLog(`AcceptLoginToken attempt=${attemptLabel} -> ${acceptResult?.className || typeof acceptResult}`);
  return acceptResult;
}

async function getNativeAutoconfirmTimeoutMs() {
  const { Api } = TelegramModule;
  if (!Api?.help?.GetConfig) {
    return 60_000;
  }

  try {
    const config = await client.invoke(new Api.help.GetConfig());
    const seconds = Number(config?.authorizationAutoconfirmPeriod || 60);
    await nativeDebugLog(`authorizationAutoconfirmPeriod=${seconds}s`);
    return Math.max(seconds, 20) * 1000;
  } catch (e) {
    await nativeDebugLog(`GetConfig failed: ${e?.message || e}`, 'w');
    return 60_000;
  }
}

async function confirmNativeAuthorizationIfNeeded(acceptResult) {
  const { Api } = TelegramModule;
  const sessionHash = acceptResult?.hash;
  const isUnconfirmed = !!acceptResult?.unconfirmed;

  await nativeDebugLog(
    `accept result unconfirmed=${isUnconfirmed} hash=${sessionHash?.toString?.() || sessionHash || 'null'}`,
  );

  if (!isUnconfirmed || sessionHash == null || !Api?.account?.ChangeAuthorizationSettings) {
    return { pendingAutoconfirm: false, waitTimeoutMs: 20_000 };
  }

  try {
    await client.invoke(
      new Api.account.ChangeAuthorizationSettings({
        confirmed: true,
        hash: sessionHash,
      }),
    );
    await nativeDebugLog('ChangeAuthorizationSettings -> confirmed');
    return { pendingAutoconfirm: false, waitTimeoutMs: 20_000 };
  } catch (e) {
    const errorMessage = e?.message || String(e);
    if (!errorMessage.includes('FRESH_RESET_AUTHORISATION_FORBIDDEN')) {
      throw e;
    }

    const waitTimeoutMs = (await getNativeAutoconfirmTimeoutMs()) + 15_000;
    await nativeDebugLog(
      `ChangeAuthorizationSettings deferred by Telegram policy, waiting ${waitTimeoutMs}ms`,
      'w',
    );
    return { pendingAutoconfirm: true, waitTimeoutMs };
  }
}

async function waitForNativeReady(nativePlugin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await nativePlugin.refreshAuthState();
    await nativeDebugLog(`refreshAuthState(poll) -> ${JSON.stringify(lastState)}`);
    if (lastState?.state === 'ready' || lastState?.state === 'error') {
      return lastState;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    try {
      lastState = await nativePlugin.waitForReady({ timeoutMs: Math.min(5000, remainingMs) });
      await nativeDebugLog(`waitForReady(chunk) -> ${JSON.stringify(lastState)}`);
      if (lastState?.state === 'ready' || lastState?.state === 'error') {
        return lastState;
      }
    } catch (_) {
      // Poll again until timeout or readiness.
    }
  }

  return lastState || nativePlugin.refreshAuthState();
}

async function completeNativeQrLogin(nativePlugin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const requestTimeoutMs = Math.min(12000, Math.max(2000, remainingMs));

    try {
      lastState = await nativePlugin.requestQrBootstrap({
        timeoutMs: requestTimeoutMs,
        forceRefresh: true
      });
      await nativeDebugLog(`post-accept requestQrBootstrap -> ${JSON.stringify(lastState)}`);
      if (lastState?.state === 'ready' || lastState?.state === 'error') {
        return lastState;
      }
    } catch (e) {
      await nativeDebugLog(`post-accept requestQrBootstrap failed: ${e?.message || e}`, 'w');
    }

    if (Date.now() >= deadline) {
      break;
    }

    lastState = await waitForNativeReady(nativePlugin, Math.min(8000, deadline - Date.now()));
    if (lastState?.state === 'ready' || lastState?.state === 'error') {
      return lastState;
    }
  }

  return lastState || nativePlugin.refreshAuthState();
}

async function bootstrapNativeSession() {
  const nativePlugin = window.Capacitor?.Plugins?.TelegramNative;
  if (!nativePlugin || !client || !isAuthed) {
    await nativeDebugLog(`bootstrap unavailable plugin=${!!nativePlugin} client=${!!client} authed=${isAuthed}`, 'w');
    console.warn('[TelegramClient] Native bootstrap unavailable:', {
      hasPlugin: !!nativePlugin,
      hasClient: !!client,
      isAuthed
    });
    return false;
  }

  try {
    await nativeDebugLog('bootstrap start');
    const configured = await nativePlugin.configure({ apiId: TG_API_ID, apiHash: TG_API_HASH });
    await nativeDebugLog(`configure -> ${JSON.stringify(configured)}`);
    console.log('[TelegramClient] Native configure state:', configured);
    let state = await nativePlugin.getAuthState();
    await nativeDebugLog(`getAuthState -> ${JSON.stringify(state)}`);
    console.log('[TelegramClient] Native initial auth state:', state);
    if (state?.state === 'ready') return true;

    let qrState = await nativePlugin.requestQrBootstrap({ timeoutMs: 12000 });
    await nativeDebugLog(`requestQrBootstrap -> ${JSON.stringify(qrState)}`);
    console.log('[TelegramClient] Native QR bootstrap state:', qrState);
    if (qrState?.state === 'ready') return true;
    if (!qrState?.qrLink) {
      await nativeDebugLog('qr bootstrap returned without qrLink', 'w');
      return false;
    }

    let acceptResult;
    try {
      acceptResult = await acceptNativeLoginToken(qrState.qrLink, 'initial');
    } catch (e) {
      const errorMessage = e?.message || String(e);
      if (!isRetryableNativeTokenError(errorMessage)) {
        throw e;
      }

      await nativeDebugLog(`retrying native token after ${errorMessage}`, 'w');
      qrState = await nativePlugin.requestQrBootstrap({ timeoutMs: 12000, forceRefresh: true });
      await nativeDebugLog(`requestQrBootstrap(refresh) -> ${JSON.stringify(qrState)}`);
      if (!qrState?.qrLink) {
        throw e;
      }
      acceptResult = await acceptNativeLoginToken(qrState.qrLink, 'refresh');
    }

    console.log('[TelegramClient] AcceptLoginToken result:', acceptResult?.className || acceptResult);
    const confirmationState = await confirmNativeAuthorizationIfNeeded(acceptResult);
    await nativeDebugLog(`native confirmation state -> ${JSON.stringify(confirmationState)}`);

    state = await completeNativeQrLogin(nativePlugin, confirmationState.waitTimeoutMs || 20000);
    await nativeDebugLog(`waitForNativeReady -> ${JSON.stringify(state)}`);
    console.log('[TelegramClient] Native final auth state:', state);
    return state?.state === 'ready';
  } catch (e) {
    const errorMessage = e?.message || String(e);
    const errorStack = e?.stack ? ` | stack=${e.stack}` : '';
    await nativeDebugLog(`bootstrap failed: ${errorMessage}${errorStack}`, 'e');
    console.warn('[TelegramClient] Native bootstrap skipped:', e?.message || e, e);
    return false;
  }
}

async function logout() {
  if (client) {
    try {
      await client.disconnect();
    } catch (e) {
      console.warn('[Logout] Disconnect error:', e);
    }
  }
  if (window.Capacitor?.Plugins?.TelegramNative) {
    try {
      await window.Capacitor.Plugins.TelegramNative.logout();
    } catch (e) {
      console.warn('[Logout] Native logout error:', e);
    }
  }
  localStorage.removeItem(SESSION_KEY);
  isAuthed = false;
  currentUserId = null;
}

/**
 * getChannelsPaged()
 * Async generator: yields batches of { id, name, username, link } for every
 * channel/supergroup the user is a member of.
 * Uses Telegram's built-in pagination to avoid loading all dialogs at once.
 *
 * @param {number} batchSize   How many dialogs to fetch per API call (max 100)
 * @param {function} onBatch   Called with each batch array as it arrives
 */
async function* getChannelsPaged(batchSize = 100, onBatch) {
  const EXCLUDED_NAMES = ['StreamApp Data', 'Telegram', 'Saved Messages'];
  let offsetDate = 0;
  let offsetId   = 0;
  let offsetPeer = new (TelegramModule.Api.InputPeerEmpty)();
  let totalFetched = 0;
  const seenIds = new Set();

  while (true) {
    let dialogs;
    try {
      // GetDialogs with manual pagination — avoids in-memory accumulation
      const result = await client.invoke(
        new TelegramModule.Api.messages.GetDialogs({
          offsetDate,
          offsetId,
          offsetPeer,
          limit: batchSize,
          hash: window.bigInt ? window.bigInt(0) : 0,
          excludePinned: false,
          folderId: null,
        })
      );
      dialogs = result;
    } catch (e) {
      if (e.message && e.message.includes('FLOOD_WAIT')) {
        const secs = parseInt(e.message.match(/\d+/)?.[0] || '5', 10);
        await new Promise(r => setTimeout(r, (secs + 1) * 1000));
        continue;
      }
      console.error('[getChannelsPaged] Error:', e.message);
      break;
    }

    if (!dialogs || !dialogs.dialogs || dialogs.dialogs.length === 0) break;

    // Build entity map from the chats/users in the result
    const entityMap = new Map();
    for (const c of (dialogs.chats || [])) entityMap.set(c.id.toString(), c);
    for (const u of (dialogs.users || [])) entityMap.set(u.id.toString(), u);

    const batch = [];
    let lastDialog = null;
    for (const dialog of dialogs.dialogs) {
      const peer = dialog.peer;
      let entityId = null;
      if (peer?.channelId) entityId = peer.channelId.toString();
      else if (peer?.chatId) entityId = peer.chatId.toString();
      else continue;

      const entity = entityMap.get(entityId);
      if (!entity) continue;

      // Only channels and megagroups
      const isChannel = entity.className === 'Channel';
      const isMegagroup = isChannel && entity.megagroup;
      const isRealChannel = isChannel && !isMegagroup;

      if (!isChannel) continue; // skip DMs / small groups
      if (seenIds.has(entityId)) continue;
      seenIds.add(entityId);

      const name = entity.title || entity.username || `Channel ${entityId}`;
      if (EXCLUDED_NAMES.includes(name)) continue;
      if (entity.left || entity.kicked) continue;

      let link;
      if (entity.username) {
        link = `https://t.me/${entity.username}`;
      } else {
        // Private channel — use internal /c/ format
        link = `https://t.me/c/${entityId}/1`;
      }

      batch.push({
        id:          entityId,
        name,
        username:    entity.username || null,
        link,
        photo:       null, // loaded lazily in UI
        isMegagroup,
        isChannel:   isRealChannel,
      });
      lastDialog = dialog;
    }

    totalFetched += batch.length;

    if (batch.length > 0) {
      if (onBatch) onBatch(batch);
      yield batch;
    }

    // If fewer results than requested, we've reached the end
    if (dialogs.dialogs.length < batchSize) break;

    // Advance offset for next page using the last dialog
    if (lastDialog) {
      offsetDate = lastDialog.date || 0;
      offsetId   = lastDialog.topMessage || 0;
      const lastPeer = lastDialog.peer;
      if (lastPeer?.channelId) {
        const ent = entityMap.get(lastPeer.channelId.toString());
        if (ent) {
          offsetPeer = new TelegramModule.Api.InputPeerChannel({
            channelId: lastPeer.channelId,
            accessHash: ent.accessHash || window.bigInt ? window.bigInt(0) : 0,
          });
        }
      } else break;
    } else break;

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[getChannelsPaged] Total fetched: ${totalFetched} channels`);
}

window.TGClient = {
  initClient, checkExistingSession, saveSession, clearSession,
  startQrLogin, startPhoneLogin, submitPhoneCode, submitPassword,
  getDialogs, getEntity, resolveChannelFromLink,
  iterMessages, getMessages,
  pushSyncData, pullSyncData,
  downloadProfilePhoto, iterDownload, getMessageMeta,
  bootstrapNativeSession,
  getChannelsPaged,
  logout,
  get isAuthed() { return isAuthed; },
  get currentUserId() { return currentUserId; },
  get client() { return client; }
};

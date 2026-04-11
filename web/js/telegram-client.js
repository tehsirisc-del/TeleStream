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
      phoneAuthState = 'error';
      if (onError) onError(err.message);
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
    if (onError) onError(e.message);
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

async function logout() {
  if (client) {
    try {
      await client.disconnect();
    } catch (e) {
      console.warn('[Logout] Disconnect error:', e);
    }
  }
  localStorage.removeItem(SESSION_KEY);
  isAuthed = false;
  currentUserId = null;
}

window.TGClient = {
  initClient, checkExistingSession, saveSession, clearSession,
  startQrLogin, startPhoneLogin, submitPhoneCode, submitPassword,
  getDialogs, getEntity, resolveChannelFromLink,
  iterMessages, getMessages,
  pushSyncData, pullSyncData,
  downloadProfilePhoto, iterDownload, getMessageMeta,
  logout,
  get isAuthed() { return isAuthed; },
  get currentUserId() { return currentUserId; },
  get client() { return client; }
};

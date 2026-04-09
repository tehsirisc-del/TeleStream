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
      currentUserId = Number(me.id);
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
    currentUserId = Number(me.id);
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
    currentUserId = Number(me.id);
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

// ── Sync channel (sources storage) ────────────────────────────────────

const SYNC_CHANNEL_NAME = 'StreamApp Data';

async function syncSourcesFromTelegram(userId) {
  try {
    const dialogs = await client.getDialogs({ limit: 100 });
    const syncChannel = dialogs.find(d => d.title === SYNC_CHANNEL_NAME && (d.isChannel || d.isGroup));
    if (!syncChannel) return null;

    const messages = await client.getMessages(syncChannel.id, { limit: 10 });
    const syncMsg = messages.find(m => m.message && m.message.startsWith('#StreamAppSources'));
    if (!syncMsg) return null;

    const lines = syncMsg.message.split('\n');
    const dataStr = lines.slice(1).join('\n').trim();
    if (dataStr.startsWith('[')) return JSON.parse(dataStr);
    
    // Decode base64 and support UTF-8 (Hebrew)
    let decodedStr = atob(dataStr);
    try { decodedStr = decodeURIComponent(escape(decodedStr)); } catch(e) {}
    
    return JSON.parse(decodedStr);
  } catch (e) {
    console.error('[Sync] Read error:', e.message);
    return null;
  }
}

async function syncSourcesToTelegram(userId) {
  try {
    const payload = await window.DB.getSyncPayload(userId);
    // Encode safely to Base64 supporting UTF-8 (Hebrew)
    const base64Str = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    const messageText = `#StreamAppSources\n${base64Str}`;

    const dialogs = await client.getDialogs({ limit: 50 });
    let syncChannel = dialogs.find(d => d.title === SYNC_CHANNEL_NAME && (d.isChannel || d.isGroup));

    if (!syncChannel) {
      // Create sync channel
      const { Api } = TelegramModule;
      const result = await client.invoke(new Api.channels.CreateChannel({
        title: SYNC_CHANNEL_NAME,
        about: 'Storage for StreamCatz configurations.',
        broadcast: true
      }));
      const channelId = result.chats[0].id;
      await client.sendMessage(channelId, { message: messageText });
    } else {
      const channelPeer = syncChannel.entity || syncChannel.id;
      const messages = await client.getMessages(channelPeer, { limit: 50 });
      const syncMsg = messages.find(m => m.message && m.message.startsWith('#StreamAppSources'));
      if (syncMsg) {
        await client.editMessage(channelPeer, { message: syncMsg.id, text: messageText });
      } else {
        await client.sendMessage(channelPeer, { message: messageText });
      }
    }
  } catch (e) {
    console.error('[Sync] Write error:', e.message);
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
  syncSourcesFromTelegram, syncSourcesToTelegram,
  downloadProfilePhoto, iterDownload, getMessageMeta,
  logout,
  get isAuthed() { return isAuthed; },
  get currentUserId() { return currentUserId; },
  get client() { return client; }
};

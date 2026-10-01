// Background service worker: owns the native messaging connection so the TV
// link survives the popup closing. An open native port keeps the worker alive.

const HOST_NAME = 'io.github.shidiqadm.openremote';
const CALL_TIMEOUT_MS = 20000;

let native = null;
let seq = 0;
const pending = new Map();
const uiPorts = new Set();

const state = {
  host: 'unknown', // unknown | ready | missing | error
  hostError: null,
  conn: 'idle', // idle | connecting | connected | reconnecting | needs_pairing | error
  device: null, // { host, name }
  tv: { isOn: null, currentApp: null, volume: null, deviceInfo: null },
  error: null,
};

function broadcast() {
  for (const port of uiPorts) safePost(port, { t: 'state', state });
}

function setState(patch) {
  Object.assign(state, patch);
  broadcast();
}

function ensureNative() {
  if (native) return native;
  native = chrome.runtime.connectNative(HOST_NAME);
  native.onMessage.addListener(onNativeMessage);
  native.onDisconnect.addListener(() => {
    const message = chrome.runtime.lastError?.message || 'The helper app stopped.';
    native = null;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(Object.assign(new Error(message), { code: 'host_gone' }));
    }
    pending.clear();
    const missing = /not found|forbidden|access to the specified native messaging host/i.test(message);
    setState({
      host: missing ? 'missing' : 'error',
      hostError: message,
      conn: state.conn === 'needs_pairing' ? 'needs_pairing' : 'idle',
    });
  });
  return native;
}

function call(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = ensureNative();
    } catch (err) {
      reject(err);
      return;
    }
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('The helper app did not respond.'), { code: 'timeout' }));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ id, cmd, ...args });
  });
}

function onNativeMessage(msg) {
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject, timer } = pending.get(msg.id);
    clearTimeout(timer);
    pending.delete(msg.id);
    if (msg.ok) resolve(msg.data);
    else reject(Object.assign(new Error(msg.error), { code: msg.code }));
    return;
  }
  if (msg.event === 'state') {
    const tv = {
      isOn: msg.isOn,
      currentApp: msg.currentApp,
      volume: msg.volume,
      deviceInfo: msg.deviceInfo,
    };
    let conn = state.conn;
    if (msg.connected) conn = 'connected';
    else if (state.conn === 'connected') conn = msg.host ? 'reconnecting' : 'idle';
    maybeShowVolume(state.tv.volume, tv.volume);
    setState({ tv, conn });
  } else if (msg.event === 'needs_pairing') {
    setState({ conn: 'needs_pairing', error: 'The TV no longer trusts this computer. Pair again.' });
  }
}

async function getStore() {
  const { devices = [], lastHost = null } = await chrome.storage.local.get(['devices', 'lastHost']);
  return { devices, lastHost };
}

async function rememberDevice(device) {
  const { devices } = await getStore();
  const rest = devices.filter((d) => d.host !== device.host);
  await chrome.storage.local.set({ devices: [device, ...rest], lastHost: device.host });
}

async function hello() {
  try {
    const info = await call('hello');
    setState({ host: 'ready', hostError: null });
    return info;
  } catch (err) {
    if (state.host !== 'missing') setState({ host: 'error', hostError: err.message });
    throw err;
  }
}

let connecting = null; // { host, promise } while a connect is in flight

function connect(device) {
  if (connecting?.host === device.host) return connecting.promise;
  const promise = doConnect(device).finally(() => {
    if (connecting?.promise === promise) connecting = null;
  });
  connecting = { host: device.host, promise };
  return promise;
}

async function doConnect(device) {
  setState({ conn: 'connecting', device, error: null });
  try {
    const snap = await call('connect', { host: device.host });
    // The user switched TVs or disconnected while this was in flight.
    if (state.device?.host !== device.host) return;
    await rememberDevice(device);
    setState({
      conn: 'connected',
      tv: { isOn: snap.isOn, currentApp: snap.currentApp, volume: snap.volume, deviceInfo: snap.deviceInfo },
    });
  } catch (err) {
    if (state.device?.host !== device.host) throw err;
    if (err.code === 'needs_pairing') setState({ conn: 'needs_pairing', error: null });
    else setState({ conn: 'error', error: err.message });
    throw err;
  }
}

// Commands the UI can send. Anything not listed is forwarded to the host as-is.
const local = {
  async init() {
    if (state.host !== 'ready') {
      try {
        await hello();
      } catch {
        return state;
      }
    }
    const { lastHost, devices } = await getStore();
    if (state.conn === 'idle' && lastHost) {
      const device = devices.find((d) => d.host === lastHost) || { host: lastHost, name: lastHost };
      connect(device).catch(() => {});
    }
    return state;
  },
  async retry_host() {
    setState({ host: 'unknown', hostError: null });
    return local.init();
  },
  async devices() {
    return (await getStore()).devices;
  },
  async connect({ device }) {
    await connect(device);
    return state;
  },
  async pair_start({ device }) {
    setState({ device, conn: 'needs_pairing', error: null });
    return call('pair_start', { host: device.host });
  },
  async pair_finish({ device, code }) {
    await call('pair_finish', { code });
    await connect(device);
    return state;
  },
  async disconnect() {
    await call('disconnect').catch(() => {});
    await chrome.storage.local.set({ lastHost: null });
    setState({ conn: 'idle', device: null, error: null, tv: { isOn: null, currentApp: null, volume: null, deviceInfo: null } });
    return state;
  },
  async forget({ host }) {
    const { devices, lastHost } = await getStore();
    await chrome.storage.local.set({
      devices: devices.filter((d) => d.host !== host),
      lastHost: lastHost === host ? null : lastHost,
    });
    if (state.device?.host === host) await local.disconnect();
    return (await getStore()).devices;
  },
};

function safePost(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    uiPorts.delete(port); // popup closed while a call was in flight
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ui') return;
  uiPorts.add(port);
  port.onDisconnect.addListener(() => uiPorts.delete(port));
  port.onMessage.addListener(async ({ t, id, cmd, args }) => {
    if (t !== 'call') return;
    try {
      const data = Object.hasOwn(local, cmd) ? await local[cmd](args || {}) : await call(cmd, args);
      safePost(port, { t: 'reply', id, ok: true, data });
    } catch (err) {
      safePost(port, { t: 'reply', id, ok: false, error: err.message, code: err.code });
    }
  });
  safePost(port, { t: 'state', state });
});

// ---- Browser-wide shortcuts (chrome://extensions/shortcuts) -----------------

const COMMAND_KEYS = {
  volume_up: 'VOLUME_UP',
  volume_down: 'VOLUME_DOWN',
  play_pause: 'MEDIA_PLAY_PAUSE',
  mute: 'VOLUME_MUTE',
  power: 'POWER',
  home: 'HOME',
  back: 'BACK',
  ok: 'DPAD_CENTER',
  up: 'DPAD_UP',
  down: 'DPAD_DOWN',
  left: 'DPAD_LEFT',
  right: 'DPAD_RIGHT',
  rewind: 'MEDIA_REWIND',
  fast_forward: 'MEDIA_FAST_FORWARD',
  next: 'MEDIA_NEXT',
  previous: 'MEDIA_PREVIOUS',
};

let volumeBadgeUntil = 0;
let badgeTimer;

function badge(text, color, ms) {
  clearTimeout(badgeTimer);
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }), ms);
}

// After a volume shortcut, show the new level on the toolbar icon.
function maybeShowVolume(before, after) {
  if (!after || Date.now() > volumeBadgeUntil) return;
  if (before && before.level === after.level && before.muted === after.muted) return;
  badge(after.muted ? 'mute' : String(after.level), '#1a73e8', 1500);
}

async function ensureConnected() {
  if (state.conn === 'connected') return true;
  if (state.host !== 'ready') {
    try {
      await hello();
    } catch {
      return false;
    }
  }
  const { lastHost, devices } = await getStore();
  const host = state.device?.host || lastHost;
  if (!host) return false;
  const device = devices.find((d) => d.host === host) || state.device || { host, name: host };
  try {
    await connect(device);
    return true;
  } catch {
    return false;
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  const key = COMMAND_KEYS[command];
  if (!key) return;
  if (!(await ensureConnected())) {
    badge('!', '#d93025', 3000);
    return;
  }
  if (key.startsWith('VOLUME')) volumeBadgeUntil = Date.now() + 3000;
  call('key', { key }).catch(() => badge('!', '#d93025', 3000));
});

// Remote UI. Talks only to background.js, which owns the native helper.

// App shortcuts. `app` is a deep link or an Android package name.
const APPS = [
  { name: 'YouTube', mark: 'Y', app: 'https://www.youtube.com', color: '#ff0033' },
  { name: 'Netflix', mark: 'N', app: 'https://www.netflix.com/title', color: '#e50914' },
  { name: 'Prime Video', mark: 'P', app: 'https://app.primevideo.com', color: '#1399ff' },
  { name: 'Disney+', mark: 'D+', app: 'https://www.disneyplus.com', color: '#0e3fbd' },
  { name: 'Spotify', mark: 'S', app: 'com.spotify.tv.android', color: '#1db954' },
  { name: 'Plex', mark: 'P', app: 'com.plexapp.android', color: '#d99a0b' },
];

const APP_NAMES = {
  'com.google.android.youtube.tv': 'YouTube',
  'com.google.android.youtube.tvmusic': 'YouTube Music',
  'com.google.android.youtube.tvkids': 'YouTube Kids',
  'com.netflix.ninja': 'Netflix',
  'com.amazon.amazonvideo.livingroom': 'Prime Video',
  'com.disney.disneyplus': 'Disney+',
  'com.spotify.tv.android': 'Spotify',
  'com.plexapp.android': 'Plex',
  'com.wbd.stream': 'Max',
  'com.hulu.livingroomplus': 'Hulu',
  'com.apple.atve.androidtv.appletv': 'Apple TV',
  'com.google.android.videos': 'Google TV',
  'com.google.android.apps.tv.launcherx': 'Home screen',
  'com.google.android.tvlauncher': 'Home screen',
  'com.android.tv.settings': 'Settings',
  'com.mitv.tvhome.atv': 'Home screen',
  'com.android.vending': 'Play Store',
};

// Keyboard → TV key, while the remote is open.
const KEYMAP = {
  ArrowUp: 'DPAD_UP',
  ArrowDown: 'DPAD_DOWN',
  ArrowLeft: 'DPAD_LEFT',
  ArrowRight: 'DPAD_RIGHT',
  Enter: 'DPAD_CENTER',
  Escape: 'BACK',
  Backspace: 'BACK',
  h: 'HOME',
  ' ': 'MEDIA_PLAY_PAUSE',
  '+': 'VOLUME_UP',
  '=': 'VOLUME_UP',
  '-': 'VOLUME_DOWN',
  _: 'VOLUME_DOWN',
  m: 'VOLUME_MUTE',
  PageUp: 'CHANNEL_UP',
  PageDown: 'CHANNEL_DOWN',
  '[': 'MEDIA_REWIND',
  ']': 'MEDIA_FAST_FORWARD',
  ',': 'MEDIA_PREVIOUS',
  '.': 'MEDIA_NEXT',
  i: 'TV_INPUT',
  s: 'SETTINGS',
  g: 'ASSIST',
};
// Keys that keep firing while held; everything else ignores auto-repeat.
const REPEATING = new Set([
  'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT',
  'VOLUME_UP', 'VOLUME_DOWN', 'CHANNEL_UP', 'CHANNEL_DOWN',
  'MEDIA_REWIND', 'MEDIA_FAST_FORWARD',
]);
// Keys where holding means a long press on the TV.
const LONG_PRESS = new Set(['DPAD_CENTER', 'HOME']);

const HELP = [
  ['Navigate', [
    [['↑', '↓', '←', '→'], 'Move'],
    [['Enter'], 'OK'],
    [['Esc'], 'Back'],
    [['H'], 'Home'],
  ]],
  ['Playback', [
    [['Space'], 'Play / pause'],
    [['[', ']'], 'Rew / FF'],
    [[',', '.'], 'Prev / next'],
    [['+', '−'], 'Volume'],
    [['M'], 'Mute'],
    [['PgUp', 'PgDn'], 'Channel'],
  ]],
  ['Open', [
    [['K'], 'Keyboard'],
    [['A'], 'Apps'],
    [['1–6'], 'Launch app'],
    [['I'], 'Input'],
    [['S'], 'Settings'],
    [['G'], 'Assistant'],
    [['⇧', 'P'], 'Power'],
    [['?'], 'Shortcuts'],
  ]],
];

const $ = (sel) => document.querySelector(sel);
const isPanel = new URLSearchParams(location.search).has('panel');
document.body.classList.toggle('panel', isPanel);

// ---- RPC to background -----------------------------------------------------

const waiting = new Map();
let rpcSeq = 0;
let state = null;
let initialized = false;
let port = null;

// The service worker can be stopped (e.g. while the helper is missing), which
// kills this port. Reconnect lazily on the next call so a long-lived side
// panel keeps working.
function getPort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: 'ui' });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    if (initialized) setTimeout(() => rpc('init').catch(() => {}), 200);
    for (const w of waiting.values()) w.reject(Object.assign(new Error('Lost connection to the extension.'), { code: 'port_closed' }));
    waiting.clear();
  });
  return port;
}

function onPortMessage(msg) {
  if (msg.t === 'reply') {
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.ok) w.resolve(msg.data);
    else w.reject(Object.assign(new Error(msg.error), { code: msg.code }));
  } else if (msg.t === 'state') {
    state = msg.state;
    render();
  }
}

function rpc(cmd, args, retried = false) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    waiting.set(id, { resolve, reject });
    try {
      getPort().postMessage({ t: 'call', id, cmd, args });
    } catch (err) {
      waiting.delete(id);
      port = null;
      if (retried) reject(err);
      else rpc(cmd, args, true).then(resolve, reject);
    }
  });
}

// ---- Views -------------------------------------------------------------

let pairing = null; // { device, phase: 'starting' | 'code' | 'submitting' }

function currentView() {
  return document.querySelector('.view:not([hidden])')?.dataset.view;
}

function show(view) {
  for (const el of document.querySelectorAll('.view')) el.hidden = el.dataset.view !== view;
  if (view !== 'remote') closeSheet();
}

function render() {
  if (!state || !initialized) return;
  if (state.host === 'missing' || state.host === 'error') {
    $('#host-error').textContent = state.hostError ? `Details: ${state.hostError}` : '';
    show('setup');
    return;
  }
  if (state.conn === 'needs_pairing' && state.device) {
    if (pairing?.device.host !== state.device.host) startPairing(state.device);
    show('pair');
    return;
  }
  pairing = null;
  if (['connecting', 'connected', 'reconnecting'].includes(state.conn) && state.device) {
    renderRemote();
    show('remote');
    return;
  }
  const err = $('#devices-error');
  err.hidden = !state.error;
  err.textContent = state.error || '';
  show('devices');
  renderSaved();
}

function renderRemote() {
  const { conn, device, tv } = state;
  $('#tv-name').textContent = device.name || device.host;
  const dot = $('#conn-dot');
  dot.className = 'dot';
  let sub;
  if (conn === 'connecting') {
    dot.classList.add('wait');
    sub = `Connecting to ${device.host}…`;
  } else if (conn === 'reconnecting') {
    dot.classList.add('wait');
    sub = 'Connection lost · reconnecting…';
  } else if (tv.isOn === false) {
    dot.classList.add('off');
    sub = 'TV is off · press power';
  } else {
    dot.classList.add('on');
    sub = tv.currentApp ? appName(tv.currentApp) : 'Connected';
  }
  $('#tv-sub').textContent = sub;
  $('.remote').classList.toggle('disabled', conn !== 'connected');

  const vol = tv.volume;
  const box = $('#volume');
  if (vol && vol.max) {
    $('#vol-fill').style.width = `${Math.round((vol.level / vol.max) * 100)}%`;
    $('#vol-text').textContent = vol.muted ? 'Muted' : `${vol.level} / ${vol.max}`;
    box.classList.toggle('muted', !!vol.muted);
  } else {
    $('#vol-fill').style.width = '0';
    $('#vol-text').textContent = '–';
    box.classList.remove('muted');
  }
}

function appName(pkg) {
  if (APP_NAMES[pkg]) return APP_NAMES[pkg];
  const tail = pkg.split('.').filter((p) => !['com', 'android', 'tv', 'atv', 'google', 'app', 'apps'].includes(p)).pop();
  return tail ? tail[0].toUpperCase() + tail.slice(1) : pkg;
}

// ---- Device picker -------------------------------------------------------

function deviceItem(device, { forgettable = false } = {}) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'device';
  btn.innerHTML = '<span class="tv-ico"><svg><use href="#i-tv"/></svg></span><span class="meta"><div class="name"></div><div class="ip"></div></span>';
  btn.querySelector('.name').textContent = device.name || device.host;
  btn.querySelector('.ip').textContent = device.host;
  btn.addEventListener('click', () => connectTo(device));
  if (forgettable) {
    const forget = document.createElement('span');
    forget.className = 'forget';
    forget.textContent = 'Forget';
    forget.setAttribute('role', 'button');
    forget.addEventListener('click', async (e) => {
      e.stopPropagation();
      await rpc('forget', { host: device.host });
      renderSaved();
    });
    btn.append(forget);
  }
  li.append(btn);
  return li;
}

async function renderSaved() {
  const devices = await rpc('devices').catch(() => []);
  $('#saved-list').replaceChildren(...devices.map((d) => deviceItem(d, { forgettable: true })));
  $('#saved-card').hidden = devices.length === 0;
}

let scanning = false;
async function scan() {
  if (scanning) return;
  scanning = true;
  const btn = document.querySelector('[data-action="scan"]');
  btn.disabled = true;
  btn.querySelector('.spinner').hidden = false;
  btn.lastElementChild.textContent = 'Scanning';
  $('#found-empty').hidden = true;
  try {
    const found = await rpc('discover', { timeout: 3 });
    $('#found-list').replaceChildren(...found.map((d) => deviceItem(d)));
    $('#found-empty').hidden = found.length > 0;
  } catch (err) {
    $('#found-empty').hidden = false;
    $('#found-empty').textContent = `Scan failed: ${err.message}`;
  } finally {
    scanning = false;
    btn.disabled = false;
    btn.querySelector('.spinner').hidden = true;
    btn.lastElementChild.textContent = 'Scan again';
  }
}

function connectTo(device) {
  rpc('connect', { device }).catch(() => {}); // outcome arrives through state
}

$('#manual-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const host = $('#manual-ip').value.trim();
  if (host) connectTo({ host, name: host });
});

// ---- Pairing -------------------------------------------------------------

async function startPairing(device) {
  pairing = { device, phase: 'starting' };
  const input = $('#pair-code');
  input.value = '';
  input.disabled = true;
  $('#pair-submit').disabled = true;
  $('#pair-error').hidden = true;
  $('#pair-status').textContent = `Asking ${device.name || device.host} for a code…`;
  try {
    const info = await rpc('pair_start', { device });
    if (pairing?.device !== device) return;
    if (info?.name && (!device.name || device.name === device.host)) device.name = info.name;
    pairing.phase = 'code';
    $('#pair-status').textContent = 'Enter the 6-character code shown on your TV.';
    input.disabled = false;
    input.focus();
  } catch (err) {
    if (pairing?.device !== device) return;
    showPairError(err.message);
  }
}

function showPairError(message) {
  const el = $('#pair-error');
  el.textContent = message;
  el.hidden = false;
}

$('#pair-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 6);
  $('#pair-submit').disabled = e.target.value.length !== 6;
  $('#pair-error').hidden = true;
});

$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pairing || pairing.phase !== 'code') return;
  const code = $('#pair-code').value;
  if (code.length !== 6) return;
  pairing.phase = 'submitting';
  $('#pair-submit').disabled = true;
  try {
    await rpc('pair_finish', { device: pairing.device, code });
  } catch (err) {
    if (!pairing) return;
    pairing.phase = 'code';
    $('#pair-submit').disabled = false;
    showPairError(err.message);
    $('#pair-code').select();
  }
});

// ---- Sending keys ----------------------------------------------------------

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

function connected() {
  return state?.conn === 'connected';
}

function sendKey(key, direction = 'SHORT') {
  if (!connected()) return;
  rpc('key', { key, direction }).catch((err) => toast(err.message));
}

function launchApp(index) {
  const entry = APPS[index];
  if (!entry || !connected()) return;
  rpc('launch', { app: entry.app })
    .then(() => toast(`Opening ${entry.name}…`))
    .catch((err) => toast(err.message));
  closeSheet();
}

// On-screen buttons: tap, hold-to-repeat, or hold-for-long-press.
function bindButton(btn) {
  const key = btn.dataset.key;
  const hold = btn.dataset.hold;
  let repeatDelay, repeatTimer, longTimer, longActive, down = false;

  const stop = () => {
    clearTimeout(repeatDelay);
    clearInterval(repeatTimer);
    btn.classList.remove('pressed');
  };

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = true;
    btn.setPointerCapture(e.pointerId);
    btn.classList.add('pressed');
    if (hold === 'repeat') {
      sendKey(key);
      repeatDelay = setTimeout(() => {
        repeatTimer = setInterval(() => sendKey(key), 110);
      }, 400);
    } else if (hold === 'long') {
      longActive = false;
      longTimer = setTimeout(() => {
        longActive = true;
        sendKey(key, 'START_LONG');
      }, 500);
    }
  });

  btn.addEventListener('pointerup', () => {
    if (!down) return; // release of a right/middle click
    down = false;
    stop();
    if (hold === 'long') {
      clearTimeout(longTimer);
      sendKey(key, longActive ? 'END_LONG' : 'SHORT');
    } else if (!hold) {
      sendKey(key);
    }
  });

  btn.addEventListener('pointercancel', () => {
    down = false;
    stop();
    clearTimeout(longTimer);
    if (longActive) sendKey(key, 'END_LONG');
    longActive = false;
  });

  if (btn.dataset.hint) btn.title = `${btn.title} · ${btn.dataset.hint}`;
}

document.querySelectorAll('[data-key]').forEach(bindButton);

// Light up the on-screen button that matches a keyboard press.
function flash(key, on) {
  const btn = document.querySelector(`[data-key="${key}"]`);
  if (!btn) return;
  btn.classList.toggle('pressed', on);
  if (on) setTimeout(() => btn.classList.remove('pressed'), 160);
}

// ---- Keyboard ----------------------------------------------------------------

const longKeys = new Map(); // event.code -> { key, timer, active }

function keyFor(e) {
  // Power needs Shift+P (not Caps Lock + P) so it is never toggled by accident.
  if (e.shiftKey && e.code === 'KeyP') return 'POWER';
  if (e.shiftKey && e.key === 'ArrowUp') return 'VOLUME_UP';
  if (e.shiftKey && e.key === 'ArrowDown') return 'VOLUME_DOWN';
  if (e.key.length === 1 && /[a-z]/i.test(e.key)) return e.shiftKey ? undefined : KEYMAP[e.key.toLowerCase()];
  return KEYMAP[e.key];
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (openSheetName) closeSheet();
      else e.target.blur();
    }
    return;
  }
  if (currentView() !== 'remote') return;
  // Let Enter/Space activate focused toolbar, sheet and app buttons normally.
  const target = e.target instanceof Element ? e.target.closest('button, a') : null;
  if (target && !target.dataset.key && (e.key === 'Enter' || e.key === ' ')) return;

  if (e.key === 'Escape' && openSheetName) {
    e.preventDefault();
    closeSheet();
    return;
  }
  const lower = e.key.toLowerCase();
  if (!e.repeat) {
    if (lower === 'k' || (e.key === '/' && !e.shiftKey)) return void (e.preventDefault(), openSheet('keyboard'));
    if (lower === 'a') return void (e.preventDefault(), toggleSheet('apps'));
    if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) return void (e.preventDefault(), toggleSheet('help'));
    if (/^[1-9]$/.test(e.key)) return void (e.preventDefault(), launchApp(Number(e.key) - 1));
  }

  const key = keyFor(e);
  if (!key) return;
  e.preventDefault();
  if (LONG_PRESS.has(key)) {
    if (e.repeat || longKeys.has(e.code)) return;
    const entry = { key, active: false };
    entry.timer = setTimeout(() => {
      entry.active = true;
      sendKey(key, 'START_LONG');
    }, 500);
    longKeys.set(e.code, entry);
    flash(key, true);
    return;
  }
  if (e.repeat && !REPEATING.has(key)) return;
  sendKey(key);
  flash(key, true);
});

document.addEventListener('keyup', (e) => {
  const entry = longKeys.get(e.code);
  if (!entry) return;
  longKeys.delete(e.code);
  clearTimeout(entry.timer);
  sendKey(entry.key, entry.active ? 'END_LONG' : 'SHORT');
});

// ---- Sheets ------------------------------------------------------------------

let openSheetName = null;

function openSheet(name) {
  if (currentView() !== 'remote') return;
  openSheetName = name;
  $('#scrim').hidden = false;
  for (const el of document.querySelectorAll('[data-sheet-panel]')) el.hidden = el.dataset.sheetPanel !== name;
  for (const el of document.querySelectorAll('.tool')) el.classList.toggle('active', el.dataset.sheet === name);
  if (name === 'keyboard') $('#type-input').focus();
  if (name === 'help') renderGlobalShortcuts();
}

function closeSheet() {
  if (!openSheetName) return;
  openSheetName = null;
  $('#scrim').hidden = true;
  for (const el of document.querySelectorAll('[data-sheet-panel]')) el.hidden = true;
  for (const el of document.querySelectorAll('.tool')) el.classList.remove('active');
  document.activeElement?.blur();
}

function toggleSheet(name) {
  if (openSheetName === name) closeSheet();
  else openSheet(name);
}

for (const btn of document.querySelectorAll('[data-sheet]')) {
  btn.addEventListener('click', () => toggleSheet(btn.dataset.sheet));
}
$('#scrim').addEventListener('click', closeSheet);

// Keyboard sheet: the TV's text field mirrors this input.
let typeTimer;
let lastTyped = '';
function syncText(text) {
  if (text === lastTyped || !connected()) return Promise.resolve();
  lastTyped = text;
  return rpc('text', { text });
}

$('#type-input').addEventListener('input', (e) => {
  clearTimeout(typeTimer);
  const text = e.target.value;
  typeTimer = setTimeout(() => syncText(text).catch((err) => toast(err.message)), 120);
});

$('#type-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(typeTimer);
  const input = $('#type-input');
  syncText(input.value)
    .then(() => sendKey('ENTER'))
    .catch((err) => toast(err.message));
  input.value = '';
  lastTyped = '';
});

// Apps sheet
$('#apps').replaceChildren(
  ...APPS.map(({ name, mark, color }, i) => {
    const btn = document.createElement('button');
    btn.className = 'app';
    btn.innerHTML = '<span class="logo"></span><span class="name"></span><kbd></kbd>';
    const logo = btn.querySelector('.logo');
    logo.textContent = mark;
    logo.style.background = color;
    btn.querySelector('.name').textContent = name;
    btn.querySelector('kbd').textContent = String(i + 1);
    btn.addEventListener('click', () => launchApp(i));
    return btn;
  }),
);

// Shortcuts sheet
$('#shortcuts').replaceChildren(
  ...HELP.flatMap(([group, items]) => {
    const h = document.createElement('h3');
    h.textContent = group;
    return [
      h,
      ...items.map(([keys, label]) => {
        const row = document.createElement('div');
        row.className = 'sc';
        const name = document.createElement('span');
        name.textContent = label;
        const caps = document.createElement('span');
        caps.append(...keys.map((k) => Object.assign(document.createElement('kbd'), { textContent: k })));
        row.append(name, caps);
        return row;
      }),
    ];
  }),
);

async function renderGlobalShortcuts() {
  const el = $('#global-list');
  try {
    const commands = await chrome.commands.getAll();
    const bound = commands.filter((c) => c.shortcut);
    if (!bound.length) {
      el.textContent = 'None set yet. Add shortcuts for volume, play/pause and more.';
      return;
    }
    el.replaceChildren(
      ...bound.map((c) => {
        const row = document.createElement('div');
        row.className = 'sc';
        const name = document.createElement('span');
        name.textContent = c.name === '_execute_action' ? 'Open remote' : c.description;
        const caps = document.createElement('span');
        caps.append(Object.assign(document.createElement('kbd'), { textContent: c.shortcut }));
        row.append(name, caps);
        return row;
      }),
    );
  } catch {
    el.textContent = 'Add shortcuts for volume, play/pause and more.';
  }
}

// ---- Actions -------------------------------------------------------------

let windowId = null;
chrome.windows?.getCurrent().then((w) => (windowId = w.id)).catch(() => {});

const actions = {
  'retry-host': () => rpc('retry_host').then(() => render()),
  scan,
  'switch-tv': () => rpc('disconnect').then(scan),
  'cancel-pair': async () => {
    pairing = null;
    await rpc('pair_cancel').catch(() => {});
    await rpc('disconnect');
  },
  'restart-pair': () => {
    if (pairing) startPairing(pairing.device);
  },
  'side-panel': () => {
    // Must run synchronously inside the click to count as a user gesture.
    if (windowId == null) return;
    chrome.sidePanel.open({ windowId }).then(() => window.close());
  },
  'close-sheet': closeSheet,
  'type-delete': () => {
    const input = $('#type-input');
    if (input.value) {
      input.value = input.value.slice(0, -1);
      input.dispatchEvent(new Event('input'));
    } else {
      sendKey('DEL');
    }
    input.focus();
  },
  'customize-shortcuts': () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action]();
});

// ---- Boot ----------------------------------------------------------------

rpc('init')
  .then((s) => {
    state = s;
    initialized = true;
    render();
    if (s.host === 'ready' && s.conn === 'idle' && !s.device) scan();
  })
  .catch(() => {
    initialized = true;
    render();
  });

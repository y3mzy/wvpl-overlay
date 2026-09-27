/**
 * West Valley RP — overlay nad grą
 * F1 = telefon (przesuwany, skalowany, animacja od dołu)
 * F2 = MDT (przesuwany, skalowany)
 * Esc = schowaj aktywne okno
 *
 * Discord OAuth: osobne okno BrowserWindow + webview allowpopups
 * (iframe blokował logowanie — stąd BLOCKED_BY_CLIENT / błędy OAuth)
 */
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  shell,
  session
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');

// Stały katalog danych poza folderem projektu (unika Error 32 na OneDrive/Desktop/lock)
try {
  const dataDir = path.join(os.homedir(), 'AppData', 'LocalLow', 'WestValleyOverlay');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);
  app.setPath('sessionData', path.join(dataDir, 'session'));
} catch (e) {
  console.warn('[overlay] userData path:', e.message);
}

/** Stałe adresy — nieedytowalne z UI */
const FIXED_PHONE_URL = 'https://wvpl.y3mzy.dev/';
const FIXED_MDT_URL = 'https://mdtlapd.y3mzy.dev/';

function getDataDir() {
  // %USERPROFILE%\AppData\LocalLow\WestValleyOverlay
  return path.join(os.homedir(), 'AppData', 'LocalLow', 'WestValleyOverlay');
}

function getConfigPath() {
  const dir = getDataDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return path.join(dir, 'config.json');
}

function getIconPath() {
  const candidates = [
    asset('wvpl.ico'),
    path.join(__dirname, 'wvpl.ico'),
    app.isPackaged ? path.join(process.resourcesPath, 'wvpl.ico') : null
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return undefined;
}

function asset(...parts) {
  if (app.isPackaged) {
    return path.join(app.getAppPath(), ...parts);
  }
  return path.join(__dirname, ...parts);
}

let config = {
  phoneUrl: FIXED_PHONE_URL,
  mdtUrl: FIXED_MDT_URL,
  phoneWidth: 380,
  phoneHeight: 780,
  mdtWidth: 1280,
  mdtHeight: 800,
  hotkeyPhone: 'F1',
  hotkeyMdt: 'F2',
  alwaysOnTop: true,
  phoneBounds: null,
  mdtBounds: null
};

function loadConfig() {
  const cfgPath = getConfigPath();
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    config = Object.assign(config, JSON.parse(raw));
    console.log('[overlay] Config:', cfgPath);
  } catch (e) {
    console.warn('[overlay] Brak config — tworzę domyślny w AppData');
  }
  // URL-e zawsze z kodu (nie z UI / nie nadpisywalne przez usera w panelu)
  config.phoneUrl = FIXED_PHONE_URL;
  config.mdtUrl = FIXED_MDT_URL;
  saveConfig();
}

function saveConfig() {
  try {
    const out = {
      phoneUrl: config.phoneUrl,
      mdtUrl: config.mdtUrl,
      phoneWidth: config.phoneWidth,
      phoneHeight: config.phoneHeight,
      mdtWidth: config.mdtWidth,
      mdtHeight: config.mdtHeight,
      mdtWidthPercent: config.mdtWidthPercent,
      mdtHeightPercent: config.mdtHeightPercent,
      hotkeyPhone: config.hotkeyPhone || 'F1',
      hotkeyMdt: config.hotkeyMdt || 'F2',
      alwaysOnTop: true,
      phoneBounds: config.phoneBounds || null,
      mdtBounds: config.mdtBounds || null
    };
    fs.writeFileSync(getConfigPath(), JSON.stringify(out, null, 2), 'utf8');
  } catch (e) {
    console.warn('[overlay] saveConfig:', e.message);
  }
}

let controlWin = null;
let phoneWin = null;
let phonePeekMode = false;
let phonePeekTimer = null;
let phoneFullBoundsY = null;
let mdtWin = null;
let authWin = null;
const APP_VERSION = '1.2.5';

/** { win, mode, startX, startY, startW, startH } */
let resizeState = null;

function defaultPhoneBounds() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(config.phoneWidth || 380, width - 20);
  const h = Math.min(config.phoneHeight || 780, height - 20);
  return {
    width: w,
    height: h,
    x: Math.round((width - w) / 2),
    y: height // start off-screen bottom (animacja)
  };
}

function defaultMdtBounds() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  let w = config.mdtWidth;
  let h = config.mdtHeight;
  if (!w && config.mdtWidthPercent) w = Math.round((wa.width * config.mdtWidthPercent) / 100);
  if (!h && config.mdtHeightPercent) h = Math.round((wa.height * config.mdtHeightPercent) / 100);
  w = w || Math.round(wa.width * 0.9);
  h = h || Math.round(wa.height * 0.88);
  return {
    width: w,
    height: h,
    x: Math.round((wa.width - w) / 2),
    y: Math.round((wa.height - h) / 2)
  };
}

function persistBounds(kind) {
  const win = kind === 'phone' ? phoneWin : mdtWin;
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  if (kind === 'phone') config.phoneBounds = b;
  else config.mdtBounds = b;
  config.phoneWidth = config.phoneBounds ? config.phoneBounds.width : config.phoneWidth;
  config.phoneHeight = config.phoneBounds ? config.phoneBounds.height : config.phoneHeight;
  if (config.mdtBounds) {
    config.mdtWidth = config.mdtBounds.width;
    config.mdtHeight = config.mdtBounds.height;
  }
  saveConfig();
}

/** Okno OAuth Discord — normalne okno, nie iframe */
function openAuthWindow(url) {
  if (authWin && !authWin.isDestroyed()) {
    authWin.focus();
    authWin.loadURL(url);
    return authWin;
  }
  authWin = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 400,
    minHeight: 500,
    title: 'Logowanie Discord',
    autoHideMenuBar: true,
    backgroundColor: '#1e1f22',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: 'persist:wv-phone'
    }
  });
  authWin.setMenuBarVisibility(false);
  authWin.loadURL(url);
  authWin.on('closed', () => {
    authWin = null;
  });
  // Po udanym logowaniu Discord wraca na redirect URI — zamknij okno auth
  // i odśwież telefon, jeśli sesja jest współdzielona (ten sam partition)
  authWin.webContents.on('did-navigate', (_e, navUrl) => {
    const u = String(navUrl || '');
    const phoneBase = String(config.phoneUrl || '').replace(/\/$/, '');
    if (
      phoneBase &&
      u.indexOf(phoneBase) === 0 &&
      (u.indexOf('code=') >= 0 || u.indexOf('token') >= 0 || u.indexOf('/api/phone') >= 0 || u.indexOf('auth') >= 0)
    ) {
      // redirect z powrotem na telefon / backend
      setTimeout(() => {
        if (phoneWin && !phoneWin.isDestroyed()) {
          phoneWin.webContents.send('auth-done');
          // przeładuj panel telefonu
          phoneWin.webContents.executeJavaScript(
            `var w=document.getElementById('view'); if(w){ var s=w.src; w.src='about:blank'; setTimeout(function(){ w.src=s; }, 50); }`
          ).catch(() => {});
        }
        if (authWin && !authWin.isDestroyed()) authWin.close();
      }, 400);
    }
  });
  return authWin;
}

function attachNavigationHandlers(win) {
  if (!win || win.isDestroyed()) return;

  win.webContents.setWindowOpenHandler(({ url }) => {
    const u = String(url || '');
    // Discord OAuth / login — osobne okno z tym samym partition (cookies)
    if (
      u.indexOf('discord.com') >= 0 ||
      u.indexOf('discordapp.com') >= 0 ||
      u.indexOf('/oauth') >= 0 ||
      u.indexOf('/api/phone/auth') >= 0
    ) {
      openAuthWindow(u);
      return { action: 'deny' };
    }
    // inne linki zewnętrzne — domyślna przeglądarka
    if (/^https?:\/\//i.test(u)) {
      shell.openExternal(u);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Gdy strona robi location = discord (nie popup)
  win.webContents.on('will-navigate', (event, url) => {
    const u = String(url || '');
    if (u.indexOf('discord.com/api/oauth') >= 0 || u.indexOf('discord.com/oauth2') >= 0) {
      event.preventDefault();
      openAuthWindow(u);
    }
  });
}

function createPhoneWindow() {
  if (phoneWin && !phoneWin.isDestroyed()) return phoneWin;

  const saved = config.phoneBounds;
  const def = defaultPhoneBounds();
  const bounds = saved && saved.width > 100 ? { ...def, ...saved, y: def.y } : def;

  phoneWin = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 300,
    minHeight: 520,
    maxWidth: 640,
    maxHeight: 1240,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    icon: getIconPath(),
    resizable: true,
    movable: true,
    hasShadow: false,
    thickFrame: false,
    roundedCorners: true,
    show: false,
    webPreferences: {
      preload: asset('preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      partition: 'persist:wv-phone'
    }
  });

  phoneWin.setAlwaysOnTop(true, 'screen-saver');
  phoneWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Pełna przezroczystość — rogi zaokrąglonej ramki nie są czarne
  phoneWin.setBackgroundColor('#00000000');
  phoneWin.loadFile(asset('phone-shell.html'));

  phoneWin.webContents.on('did-finish-load', () => {
    phoneWin.webContents.send('init-panel', {
      kind: 'phone',
      url: config.phoneUrl || 'about:blank',
      title: 'Telefon'
    });
  });

  attachNavigationHandlers(phoneWin);

  phoneWin.on('resize', () => persistBounds('phone'));
  phoneWin.on('move', () => {
    if (phoneWin && !phoneWin.isDestroyed() && phoneWin.isVisible()) {
      // nie zapisuj pozycji podczas animacji startowej
      const b = phoneWin.getBounds();
      if (b.y < screen.getPrimaryDisplay().workAreaSize.height - 40) {
        persistBounds('phone');
      }
    }
  });
  phoneWin.on('closed', () => {
    phoneWin = null;
    phonePeekMode = false;
    clearPhonePeekTimer();
  });

  phoneWin.on('focus', () => {
    if (phonePeekMode) phonePeekExpand();
  });


  return phoneWin;
}

function createMdtWindow() {
  if (mdtWin && !mdtWin.isDestroyed()) return mdtWin;

  const saved = config.mdtBounds;
  const def = defaultMdtBounds();
  const bounds = saved && saved.width > 200 ? { ...def, ...saved } : def;

  mdtWin = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 640,
    minHeight: 400,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    icon: getIconPath(),
    resizable: true,
    movable: true,
    hasShadow: false,
    thickFrame: true,
    show: false,
    webPreferences: {
      preload: asset('preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      partition: 'persist:wv-mdt'
    }
  });

  mdtWin.setAlwaysOnTop(true, 'screen-saver');
  mdtWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mdtWin.loadURL(config.mdtUrl || 'about:blank');

  const MDT_UI_CSS = `
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      width: 100% !important;
      height: 100% !important;
      overflow: auto !important;
    }
    html {
      background: linear-gradient(145deg, #2a2e35 0%, #1a1d23 30%, #12141a 70%, #1c1f26 100%) !important;
      border-radius: 18px !important;
      padding: 20px 18px 22px 18px !important;
      box-sizing: border-box !important;
      box-shadow:
        0 0 0 1px rgba(0,0,0,.8),
        0 0 0 3px #3d4450,
        0 0 0 5px #1a1c22,
        0 0 0 6px rgba(255,255,255,.04),
        inset 0 1px 0 rgba(255,255,255,.08) !important;
    }
    body {
      border-radius: 6px !important;
      background: #0a0b10 !important;
      overflow: auto !important;
      box-shadow:
        0 0 0 1px rgba(0,0,0,.9),
        0 0 0 2px #1e222b !important;
      min-height: 100% !important;
    }
    #wv-overlay-drag {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      right: 12px !important;
      height: 18px !important;
      z-index: 2147483646 !important;
      -webkit-app-region: drag !important;
      background: transparent !important;
    }
    #wv-overlay-resize-r {
      position: fixed !important;
      top: 0 !important; right: 0 !important;
      width: 10px !important; height: 100% !important;
      z-index: 2147483647 !important;
      -webkit-app-region: no-drag !important;
      cursor: ew-resize !important;
    }
    #wv-overlay-resize-c {
      position: fixed !important;
      right: 0 !important; bottom: 0 !important;
      width: 18px !important; height: 18px !important;
      z-index: 2147483647 !important;
      -webkit-app-region: no-drag !important;
      cursor: nwse-resize !important;
    }
    #wv-mdt-badge {
      position: fixed !important;
      bottom: 6px !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      font-size: 8px !important;
      letter-spacing: 1.5px !important;
      font-weight: 600 !important;
      color: rgba(180,190,210,.25) !important;
      text-transform: uppercase !important;
      pointer-events: none !important;
      z-index: 2147483645 !important;
      font-family: system-ui, sans-serif !important;
    }
    a, button, input, textarea, select {
      -webkit-app-region: no-drag !important;
    }
  `;

  function injectMdtChrome() {
    if (!mdtWin || mdtWin.isDestroyed()) return;
    const wc = mdtWin.webContents;
    wc.insertCSS(MDT_UI_CSS).catch(() => {});
    wc.executeJavaScript(`
      (function(){
        function ensure(id) {
          var el = document.getElementById(id);
          if (el) return el;
          el = document.createElement('div');
          el.id = id;
          document.documentElement.appendChild(el);
          return el;
        }
        ensure('wv-overlay-drag');
        ensure('wv-overlay-resize-r');
        ensure('wv-overlay-resize-c');
        var b = ensure('wv-mdt-badge');
        b.textContent = 'MDT · FIELD UNIT';
        function bindResize(el, mode) {
          if (!el || el.dataset.wvBound) return;
          el.dataset.wvBound = '1';
          el.addEventListener('mousedown', function(e){
            e.preventDefault(); e.stopPropagation();
            window.postMessage({ type: 'wv-resize-start', mode: mode, x: e.screenX, y: e.screenY }, '*');
            function move(ev) {
              window.postMessage({ type: 'wv-resize-move', x: ev.screenX, y: ev.screenY }, '*');
            }
            function up() {
              window.removeEventListener('mousemove', move, true);
              window.removeEventListener('mouseup', up, true);
              window.postMessage({ type: 'wv-resize-end' }, '*');
            }
            window.addEventListener('mousemove', move, true);
            window.addEventListener('mouseup', up, true);
          }, true);
        }
        bindResize(document.getElementById('wv-overlay-resize-r'), 'right');
        bindResize(document.getElementById('wv-overlay-resize-c'), 'corner');
      })();
    `).catch(() => {});
  }

  mdtWin.webContents.on('did-finish-load', () => {
    injectMdtChrome();
    setTimeout(injectMdtChrome, 300);
  });
  mdtWin.webContents.on('dom-ready', injectMdtChrome);

  attachNavigationHandlers(mdtWin);

  mdtWin.on('resize', () => persistBounds('mdt'));
  mdtWin.on('move', () => persistBounds('mdt'));
  mdtWin.on('closed', () => {
    mdtWin = null;
  });

  return mdtWin;
}

function animatePhoneIn(win) {
  phonePeekMode = false;
  clearPhonePeekTimer();
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const b = win.getBounds();
  const targetY = Math.min(
    (config.phoneBounds && config.phoneBounds.y != null)
      ? config.phoneBounds.y
      : wa.height - b.height - 16,
    wa.height - b.height - 8
  );
  const startY = wa.height + 10;
  win.setBounds({ x: b.x, y: startY, width: b.width, height: b.height });
  win.show();
  win.focus();

  const duration = 420;
  const t0 = Date.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);

  function step() {
    if (!win || win.isDestroyed()) return;
    const p = Math.min(1, (Date.now() - t0) / duration);
    const y = Math.round(startY + (targetY - startY) * ease(p));
    const cur = win.getBounds();
    win.setBounds({ x: cur.x, y, width: cur.width, height: cur.height });
    if (p < 1) setTimeout(step, 16);
    else persistBounds('phone');
  }
  step();
}

function animatePhoneOut(win) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve();
    const wa = screen.getPrimaryDisplay().workAreaSize;
    const b = win.getBounds();
    const startY = b.y;
    const endY = wa.height + 20;
    const duration = 280;
    const t0 = Date.now();
    const ease = (t) => t * t;

    function step() {
      if (!win || win.isDestroyed()) return resolve();
      const p = Math.min(1, (Date.now() - t0) / duration);
      const y = Math.round(startY + (endY - startY) * ease(p));
      win.setBounds({ x: b.x, y, width: b.width, height: b.height });
      if (p < 1) setTimeout(step, 16);
      else {
        win.hide();
        resolve();
      }
    }
    step();
  });
}

function pushOverlayStatus() {
  const phoneOpen = !!(phoneWin && !phoneWin.isDestroyed() && phoneWin.isVisible());
  const mdtOpen = !!(mdtWin && !mdtWin.isDestroyed() && mdtWin.isVisible());
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('control-status', {
      ok: true,
      phoneOpen,
      mdtOpen,
      text: 'Gotowy · ' + (config.hotkeyPhone || 'F1') + ' telefon · ' + (config.hotkeyMdt || 'F2') + ' MDT'
        + (phoneOpen ? ' · telefon otwarty' : '')
        + (mdtOpen ? ' · MDT otwarte' : '')
    });
  }
}


function clearPhonePeekTimer() {
  if (phonePeekTimer) {
    clearTimeout(phonePeekTimer);
    phonePeekTimer = null;
  }
}

function animatePhonePeekIn(win) {
  if (!win || win.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const b = win.getBounds();
  // widoczne ~28% wysokości telefonu od dołu
  const visibleH = Math.max(160, Math.round(b.height * 0.28));
  const targetY = wa.height - visibleH;
  const startY = wa.height + 10;

  if (!win.isVisible()) {
    win.setBounds({ x: b.x, y: startY, width: b.width, height: b.height });
    try { win.showInactive(); } catch (_) { win.show(); }
  }

  const duration = 320;
  const t0 = Date.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const fromY = win.getBounds().y;

  function step() {
    if (!win || win.isDestroyed()) return;
    const p = Math.min(1, (Date.now() - t0) / duration);
    const y = Math.round(fromY + (targetY - fromY) * ease(p));
    const cur = win.getBounds();
    win.setBounds({ x: cur.x, y, width: cur.width, height: cur.height });
    if (p < 1) setTimeout(step, 16);
  }
  step();
}

function phonePeekNotify() {
  const win = createPhoneWindow();
  // już w pełni otwarty — nic nie rób (toast i tak w webview)
  if (win.isVisible() && !phonePeekMode) return;

  phonePeekMode = true;
  clearPhonePeekTimer();
  animatePhonePeekIn(win);
  pushOverlayStatus();

  phonePeekTimer = setTimeout(() => {
    if (!phonePeekMode) return;
    phonePeekMode = false;
    if (phoneWin && !phoneWin.isDestroyed() && phoneWin.isVisible()) {
      animatePhoneOut(phoneWin).then(pushOverlayStatus).catch(pushOverlayStatus);
    }
  }, 4800);
}

function phonePeekExpand() {
  if (!phonePeekMode) return;
  phonePeekMode = false;
  clearPhonePeekTimer();
  const win = createPhoneWindow();
  animatePhoneIn(win);
  setTimeout(pushOverlayStatus, 450);
}


function togglePhone() {
  const win = createPhoneWindow();
  if (phonePeekMode) {
    phonePeekExpand();
    setTimeout(() => broadcastStatus(true), 50);
    return;
  }
  if (win.isVisible()) {
    phonePeekMode = false;
    clearPhonePeekTimer();
    animatePhoneOut(win).then(function () { pushOverlayStatus(); }).catch(function () { pushOverlayStatus(); });
  } else {
    animatePhoneIn(win);
    setTimeout(pushOverlayStatus, 450);
  }
  setTimeout(() => broadcastStatus(true), 50);
}

function toggleMdt() {
  const win = createMdtWindow();
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
  setTimeout(pushOverlayStatus, 50);
}

function hideAll() {
  if (phoneWin && !phoneWin.isDestroyed() && phoneWin.isVisible()) {
    animatePhoneOut(phoneWin).then(pushOverlayStatus).catch(pushOverlayStatus);
  }
  if (mdtWin && !mdtWin.isDestroyed() && mdtWin.isVisible()) {
    mdtWin.hide();
  }
  setTimeout(pushOverlayStatus, 320);
}

ipcMain.on('panel-close', (_e, kind) => {
  if (kind === 'phone' && phoneWin && !phoneWin.isDestroyed()) {
    animatePhoneOut(phoneWin).then(pushOverlayStatus).catch(pushOverlayStatus);
  }
  if (kind === 'mdt' && mdtWin && !mdtWin.isDestroyed()) mdtWin.hide();
  setTimeout(pushOverlayStatus, 320);
});

ipcMain.on('panel-minimize', (_e, kind) => {
  if (kind === 'phone' && phoneWin && !phoneWin.isDestroyed()) {
    animatePhoneOut(phoneWin).then(pushOverlayStatus).catch(pushOverlayStatus);
  }
  if (kind === 'mdt' && mdtWin && !mdtWin.isDestroyed()) mdtWin.hide();
  setTimeout(pushOverlayStatus, 320);
});

ipcMain.on('open-auth-url', (_e, url) => {
  if (url) openAuthWindow(String(url));
});

ipcMain.on('set-zoom', (e, delta) => {
  const wc = e.sender;
  if (!wc) return;
  const cur = wc.getZoomFactor();
  const next = Math.min(1.6, Math.max(0.6, cur + (delta || 0)));
  wc.setZoomFactor(next);
});

ipcMain.on('resize-start', (e, payload) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  resizeState = {
    win,
    mode: (payload && payload.mode) || 'right',
    startX: payload.screenX,
    startY: payload.screenY,
    startW: b.width,
    startH: b.height,
    startXpos: b.x,
    startYpos: b.y
  };
});

ipcMain.on('resize-move', (e, payload) => {
  if (!resizeState || !resizeState.win || resizeState.win.isDestroyed()) return;
  const dx = (payload.screenX || 0) - resizeState.startX;
  const dy = (payload.screenY || 0) - resizeState.startY;
  let w = resizeState.startW;
  let h = resizeState.startH;
  if (resizeState.mode === 'right' || resizeState.mode === 'corner') {
    w = resizeState.startW + dx;
  }
  if (resizeState.mode === 'corner') {
    h = resizeState.startH + dy;
  }
  const minW = resizeState.win === phoneWin ? 280 : 640;
  const minH = resizeState.win === phoneWin ? 480 : 400;
  const maxW = resizeState.win === phoneWin ? 600 : 2400;
  const maxH = resizeState.win === phoneWin ? 1200 : 1600;
  w = Math.min(maxW, Math.max(minW, Math.round(w)));
  h = Math.min(maxH, Math.max(minH, Math.round(h)));
  resizeState.win.setBounds({
    x: resizeState.startXpos,
    y: resizeState.startYpos,
    width: w,
    height: h
  });
});

ipcMain.on('resize-end', () => {
  if (resizeState && resizeState.win && !resizeState.win.isDestroyed()) {
    const kind = resizeState.win === phoneWin ? 'phone' : 'mdt';
    persistBounds(kind);
  }
  resizeState = null;
});



ipcMain.handle('control-get-config', () => {
  return {
    phoneUrl: config.phoneUrl,
    mdtUrl: config.mdtUrl,
    phoneWidth: config.phoneWidth,
    phoneHeight: config.phoneHeight,
    mdtWidth: config.mdtWidth,
    mdtHeight: config.mdtHeight,
    hotkeyPhone: config.hotkeyPhone || 'F1',
    hotkeyMdt: config.hotkeyMdt || 'F2',
    version: APP_VERSION
  };
});

ipcMain.handle('control-save-config', (_e, cfg) => {
  if (!cfg || typeof cfg !== 'object') throw new Error('Brak danych');
  // URL-e zablokowane — zawsze FIXED_*
  config.phoneUrl = FIXED_PHONE_URL;
  config.mdtUrl = FIXED_MDT_URL;
  if (cfg.phoneWidth) config.phoneWidth = parseInt(cfg.phoneWidth, 10) || config.phoneWidth;
  if (cfg.phoneHeight) config.phoneHeight = parseInt(cfg.phoneHeight, 10) || config.phoneHeight;
  if (cfg.mdtWidth) config.mdtWidth = parseInt(cfg.mdtWidth, 10) || config.mdtWidth;
  if (cfg.mdtHeight) config.mdtHeight = parseInt(cfg.mdtHeight, 10) || config.mdtHeight;
  if (cfg.hotkeyPhone) config.hotkeyPhone = String(cfg.hotkeyPhone).trim();
  if (cfg.hotkeyMdt) config.hotkeyMdt = String(cfg.hotkeyMdt).trim();
  saveConfig();
  registerHotkeys();
  broadcastStatus(true, 'Skróty zapisane · ' + (config.hotkeyPhone || 'F1') + ' / ' + (config.hotkeyMdt || 'F2'));
  return { ok: true };
});

ipcMain.handle('control-get-status', () => {
  const phoneOpen = !!(phoneWin && !phoneWin.isDestroyed() && phoneWin.isVisible());
  const mdtOpen = !!(mdtWin && !mdtWin.isDestroyed() && mdtWin.isVisible());
  return {
    ok: true,
    text: 'Gotowy · ' + (config.hotkeyPhone || 'F1') + ' telefon · ' + (config.hotkeyMdt || 'F2') + ' MDT'
      + (phoneOpen ? ' · telefon otwarty' : '')
      + (mdtOpen ? ' · MDT otwarte' : ''),
    phoneOpen,
    mdtOpen,
    version: APP_VERSION
  };
});

ipcMain.on('control-toggle-phone', () => togglePhone());
ipcMain.on('phone-peek-notify', () => { try { phonePeekNotify(); } catch (e) {} });
ipcMain.on('phone-peek-expand', () => { try { phonePeekExpand(); } catch (e) {} });
ipcMain.on('control-toggle-mdt', () => toggleMdt());
ipcMain.on('control-minimize', () => {
  if (controlWin && !controlWin.isDestroyed()) controlWin.minimize();
});

ipcMain.handle('control-get-update', () => updateInfo);
ipcMain.handle('control-check-update', async () => checkForUpdates());
ipcMain.on('control-open-releases', () => {
  shell.openExternal(RELEASES_PAGE);
});

ipcMain.on('control-quit', () => {
  destroyOverlays();
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.removeAllListeners('closed');
    controlWin.close();
  }
  app.quit();
});

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const phoneKey = config.hotkeyPhone || 'F1';
  const mdtKey = config.hotkeyMdt || 'F2';
  if (!globalShortcut.register(phoneKey, togglePhone)) {
    console.warn('[overlay] Hotkey zajęty:', phoneKey);
  }
  if (!globalShortcut.register(mdtKey, toggleMdt)) {
    console.warn('[overlay] Hotkey zajęty:', mdtKey);
  }
  globalShortcut.register('Escape', hideAll);
  console.log('[overlay] Hotkeys:', phoneKey, mdtKey, 'Esc');
}

/** Główne okno konfiguracji — od niego zależy cały overlay */

const GITHUB_LATEST = 'https://api.github.com/repos/y3mzy/wvpl-overlay/releases/latest';
const RELEASES_PAGE = 'https://github.com/y3mzy/wvpl-overlay/releases';
let updateInfo = {
  checking: true,
  current: APP_VERSION,
  latest: null,
  upToDate: null,
  error: null
};

function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '');
}

function compareSemver(a, b) {
  const pa = normalizeVersion(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      GITHUB_LATEST,
      {
        headers: {
          'User-Agent': 'WestValley-Overlay/' + APP_VERSION,
          Accept: 'application/vnd.github+json'
        },
        timeout: 12000
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error('GitHub HTTP ' + res.statusCode));
            return;
          }
          try {
            const data = JSON.parse(body);
            resolve(data);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

async function checkForUpdates() {
  updateInfo = {
    checking: true,
    current: APP_VERSION,
    latest: null,
    upToDate: null,
    error: null
  };
  try {
    const data = await fetchLatestRelease();
    const latest = normalizeVersion(data.tag_name || data.name || '');
    const current = normalizeVersion(APP_VERSION);
    const cmp = compareSemver(current, latest);
    updateInfo = {
      checking: false,
      current: APP_VERSION,
      latest: latest || null,
      upToDate: cmp >= 0,
      error: null,
      htmlUrl: data.html_url || RELEASES_PAGE
    };
  } catch (e) {
    updateInfo = {
      checking: false,
      current: APP_VERSION,
      latest: null,
      upToDate: null,
      error: e.message || 'Błąd sprawdzania'
    };
  }
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('control-update-info', updateInfo);
  }
  return updateInfo;
}

function getShortcutFlagPath() {
  return path.join(getDataDir(), 'shortcut-installed.flag');
}

function createWindowsShortcuts() {
  if (process.platform !== 'win32') return;
  try {
    if (fs.existsSync(getShortcutFlagPath())) return;
  } catch (_) {}

  const ico = getIconPath() || '';
  let target = process.execPath;
  let args = '';
  // Dev: electron . — skrót do electron z cwd projektu
  if (!app.isPackaged) {
    target = process.execPath;
    args = '"' + path.join(__dirname) + '"';
  }

  const startMenuDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'West Valley RP'
  );
  try {
    if (!fs.existsSync(startMenuDir)) fs.mkdirSync(startMenuDir, { recursive: true });
  } catch (e) {
    console.warn('[overlay] Start Menu dir:', e.message);
  }

  const lnkStart = path.join(startMenuDir, 'West Valley Overlay.lnk');
  const desktop = path.join(os.homedir(), 'Desktop', 'West Valley Overlay.lnk');

  const psScript = `
$ErrorActionPreference = 'Stop'
$WshShell = New-Object -ComObject WScript.Shell
function Make-Shortcut($path, $target, $arguments, $icon, $workdir) {
  $s = $WshShell.CreateShortcut($path)
  $s.TargetPath = $target
  if ($arguments) { $s.Arguments = $arguments }
  if ($icon -and (Test-Path $icon)) { $s.IconLocation = $icon }
  if ($workdir) { $s.WorkingDirectory = $workdir }
  $s.Description = 'West Valley Overlay — telefon i MDT'
  $s.Save()
}
$target = @'
${String(target || "").replace(/'/g, "''")}
'@
$arguments = @'
${String(args || "").replace(/'/g, "''")}
'@
$icon = @'
${String(ico || "").replace(/'/g, "''")}
'@
$workdir = @'
${String(app.isPackaged ? path.dirname(process.execPath) : __dirname).replace(/'/g, "''")}
'@
Make-Shortcut @'
${String(lnkStart || "").replace(/'/g, "''")}
'@ $target $arguments $icon $workdir
try {
  Make-Shortcut @'
${String(desktop || "").replace(/'/g, "''")}
'@ $target $arguments $icon $workdir
} catch {}
`

  const psPath = path.join(getDataDir(), 'create-shortcut.ps1');
  try {
    fs.writeFileSync(psPath, psScript, 'utf8');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath],
      { windowsHide: true, timeout: 15000 },
      (err) => {
        if (err) {
          console.warn('[overlay] shortcut:', err.message);
          return;
        }
        try {
          fs.writeFileSync(getShortcutFlagPath(), new Date().toISOString(), 'utf8');
          console.log('[overlay] Skrót Start Menu + Desktop utworzony');
        } catch (_) {}
      }
    );
  } catch (e) {
    console.warn('[overlay] shortcut write:', e.message);
  }
}


function createControlWindow() {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.show();
    controlWin.focus();
    return controlWin;
  }

  const ico = getIconPath();
  controlWin = new BrowserWindow({
    width: 880,
    height: 620,
    minWidth: 640,
    minHeight: 480,
    frame: false,
    transparent: false,
    backgroundColor: '#07080c',
    title: 'West Valley Overlay',
    icon: ico,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: asset('preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  controlWin.once('ready-to-show', () => {
    controlWin.show();
    controlWin.focus();
  });

  controlWin.loadFile(asset('control.html'));

  controlWin.on('closed', () => {
    controlWin = null;
    // Zamknięcie panelu = koniec wszystkiego
    destroyOverlays();
    app.quit();
  });

  return controlWin;
}

function destroyOverlays() {
  try { globalShortcut.unregisterAll(); } catch (_) {}
  [phoneWin, mdtWin, authWin].forEach((w) => {
    try {
      if (w && !w.isDestroyed()) w.destroy();
    } catch (_) {}
  });
  phoneWin = null;
  mdtWin = null;
  authWin = null;
}

function getOverlayFlags() {
  return {
    phoneOpen: !!(phoneWin && !phoneWin.isDestroyed() && phoneWin.isVisible()),
    mdtOpen: !!(mdtWin && !mdtWin.isDestroyed() && mdtWin.isVisible())
  };
}

function broadcastStatus(ok, text) {
  if (!controlWin || controlWin.isDestroyed()) return;
  const flags = getOverlayFlags();
  const autoText =
    'Gotowy · ' + (config.hotkeyPhone || 'F1') + ' telefon · ' + (config.hotkeyMdt || 'F2') + ' MDT'
    + (flags.phoneOpen ? ' · telefon otwarty' : '')
    + (flags.mdtOpen ? ' · MDT otwarte' : '');
  controlWin.webContents.send('control-status', {
    ok: ok !== false,
    text: text || autoText,
    phoneOpen: flags.phoneOpen,
    mdtOpen: flags.mdtOpen,
    version: APP_VERSION
  });
}

// Wspólna sesja telefonu — cookies Discord OAuth
function setupSession() {
  const ses = session.fromPartition('persist:wv-phone');
  // Nie blokuj third-party cookies potrzebnych do OAuth
  try {
    ses.cookies.set({
      url: 'https://discord.com',
      name: 'wv_overlay',
      value: '1',
      expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30
    }).catch(() => {});
  } catch (_) {}
}

// Jedna instancja — przy błędzie locka (kod 32) i tak startujemy
let gotLock = false;
try {
  gotLock = app.requestSingleInstanceLock();
} catch (e) {
  console.warn('[overlay] requestSingleInstanceLock:', e.message);
  gotLock = true;
}
if (!gotLock) {
  console.log('[overlay] Inna instancja już działa — zamykam tę.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (controlWin && !controlWin.isDestroyed()) {
      if (controlWin.isMinimized()) controlWin.restore();
      controlWin.show();
      controlWin.focus();
    }
  });

// OAuth i popupy z webview (guest)
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    const u = String(url || '');
    if (
      u.indexOf('discord.com') >= 0 ||
      u.indexOf('discordapp.com') >= 0 ||
      u.indexOf('/oauth') >= 0 ||
      u.indexOf('/api/phone/auth') >= 0
    ) {
      openAuthWindow(u);
      return { action: 'deny' };
    }
    if (/^https?:\/\//i.test(u)) {
      shell.openExternal(u);
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          partition: contents.session ? undefined : 'persist:wv-phone',
          nodeIntegration: false,
          contextIsolation: true
        }
      }
    };
  });

  contents.on('will-navigate', (event, url) => {
    const u = String(url || '');
    // Tylko gdy to guest webview / okno telefonu próbuje iść na Discord OAuth
    if (u.indexOf('discord.com/api/oauth') >= 0 || u.indexOf('discord.com/oauth2') >= 0) {
      event.preventDefault();
      openAuthWindow(u);
    }
  });
});

  app.whenReady().then(() => {
    loadConfig();
    setupSession();
    createWindowsShortcuts();
    createControlWindow();
    registerHotkeys();
    checkForUpdates().catch(() => {});
    broadcastStatus(true, 'Gotowy · skróty aktywne');
    console.log('[overlay] v' + APP_VERSION + ' — panel sterowania gotowy');
  });
}

app.on('will-quit', () => {
  try { persistBounds('phone'); } catch (_) {}
  try { persistBounds('mdt'); } catch (_) {}
  destroyOverlays();
});

app.on('window-all-closed', () => {
  destroyOverlays();
  app.quit();
});

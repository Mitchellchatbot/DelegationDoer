// Bubble-style widget with drag-to-snap.
//
// - Window starts at 64x64 in the bottom-right corner, transparent, always-on-top.
// - Click the bubble to expand into the 380x520 panel from the same anchor.
// - Drag the bubble: it tracks the cursor; on release, it snaps to the nearest
//   of 8 anchors (4 corners + 4 edge midpoints) on whichever display it's on.
// - That anchor is remembered, so collapse/expand keeps the same corner/edge.

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, shell, Notification } = require("electron");
const path = require("path");

// Production deploy by default. `DD_APP_URL=http://localhost:3000 npm run electron`
// for local dev against the Next.js dev server.
const APP_URL = process.env.DD_APP_URL || "https://delegationdoer-production.up.railway.app";
const WIDGET_URL = `${APP_URL}/widget`;

// Each window is sized larger than its visible content so the rounded
// card's drop shadow has somewhere to render without being clipped at
// the window edge. The renderer adds matching padding (p-5 / 20px) so
// the visible card stays the same size as before.
//
// BUBBLE: 64x64 icon + ~16px margin each side for the icon's drop-shadow
//   (and the gold EOM crown glow when crowned).
// ALERT/PANEL: ~20px shadow margin per side on top of the card's natural
//   width/height.
const BUBBLE = { w: 96, h: 96 };
// Notification window. Width is fixed and generous so the card (right-
// aligned toward the bubble) never clips horizontally. Height here is only
// the pre-measurement default/fallback — the renderer measures the actual
// (compact) card once it mounts and calls widget:set-alert-size to fit the
// window snugly around it (see the handler below). Kept a touch taller than
// the compact card so it's fully visible even for the one frame before the
// measured height lands, and so old renderer shells that never call
// set-alert-size still show the card complete (compact card < this height).
const ALERT  = { w: 900, h: 220 };
const PANEL  = { w: 420, h: 560 };
const MARGIN = 16;

function sizeForState(state) {
  return state === "panel" ? PANEL : state === "alert" ? ALERT : BUBBLE;
}

const ANCHOR_NAMES = ["tl", "tc", "tr", "ml", "mr", "bl", "bc", "br"];
let currentAnchor = "br";

let widget = null;
let tray = null;
let dragOffset = null;

function currentDisplay() {
  if (!widget) return screen.getPrimaryDisplay();
  const [x, y] = widget.getPosition();
  const [w, h] = widget.getSize();
  return screen.getDisplayMatching({ x, y, width: w, height: h });
}

function getAnchors(size) {
  const wa = currentDisplay().workArea;
  const m = MARGIN;
  return {
    tl: { x: wa.x + m,                              y: wa.y + m },
    tc: { x: wa.x + Math.round(wa.width / 2 - size.w / 2), y: wa.y + m },
    tr: { x: wa.x + wa.width - size.w - m,          y: wa.y + m },
    ml: { x: wa.x + m,                              y: wa.y + Math.round(wa.height / 2 - size.h / 2) },
    mr: { x: wa.x + wa.width - size.w - m,          y: wa.y + Math.round(wa.height / 2 - size.h / 2) },
    bl: { x: wa.x + m,                              y: wa.y + wa.height - size.h - m },
    bc: { x: wa.x + Math.round(wa.width / 2 - size.w / 2), y: wa.y + wa.height - size.h - m },
    br: { x: wa.x + wa.width - size.w - m,          y: wa.y + wa.height - size.h - m }
  };
}

function setSize(target, animate = true) {
  if (!widget) return;
  const a = getAnchors(target)[currentAnchor] || getAnchors(target).br;
  widget.setBounds({ x: a.x, y: a.y, width: target.w, height: target.h }, animate);
}

function snapToNearestAnchor() {
  if (!widget) return;
  const [wx, wy] = widget.getPosition();
  const [w, h] = widget.getSize();
  const cx = wx + w / 2;
  const cy = wy + h / 2;
  const anchors = getAnchors({ w, h });

  let best = "br", bestD = Infinity;
  for (const name of ANCHOR_NAMES) {
    const a = anchors[name];
    const d = (a.x + w / 2 - cx) ** 2 + (a.y + h / 2 - cy) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  currentAnchor = best;
  const a = anchors[best];
  widget.setBounds({ x: a.x, y: a.y, width: w, height: h }, true);
}

function createWidget() {
  const a = getAnchors(BUBBLE)[currentAnchor];

  widget = new BrowserWindow({
    width: BUBBLE.w,
    height: BUBBLE.h,
    x: a.x,
    y: a.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow DevTools so we can debug the renderer in dev. We open it
      // automatically when pointed at localhost (see below).
      devTools: true
    }
  });

  // Auto-open DevTools when running against the dev server. Detached so
  // it doesn't try to fit inside the 88x88 widget window.
  if (APP_URL.includes("localhost") || APP_URL.includes("127.0.0.1")) {
    widget.webContents.openDevTools({ mode: "detach" });
  }

  // Wire keyboard shortcuts on the widget itself: Cmd/Ctrl+Opt+I to
  // toggle DevTools, Cmd/Ctrl+R to force reload. Default Electron menu
  // accelerators don't fire on a frameless transparent window like ours.
  widget.webContents.on("before-input-event", (_e, input) => {
    const mod = process.platform === "darwin" ? input.meta : input.control;
    if (!mod) return;
    if (input.alt && (input.key === "i" || input.key === "I")) {
      widget.webContents.isDevToolsOpened()
        ? widget.webContents.closeDevTools()
        : widget.webContents.openDevTools({ mode: "detach" });
    }
    if (input.key === "r" || input.key === "R") {
      widget.webContents.reloadIgnoringCache();
    }
  });

  // Block navigation to file:// URLs. Without this, dropping a file
  // anywhere outside the renderer's own dropzones would navigate the
  // widget to file:///… and the app would disappear. The renderer's
  // dropzones call e.preventDefault() to handle the drop themselves;
  // anything else gets swallowed here.
  widget.webContents.on("will-navigate", (e, url) => {
    if (url && (url.startsWith("file://") || !url.startsWith(APP_URL))) {
      e.preventDefault();
    }
  });

  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Only show after the page actually loads successfully — otherwise on cold
  // boot we'd display Electron's failed-load chrome (white rectangle).
  let loaded = false;
  widget.webContents.on("did-finish-load", () => {
    loaded = true;
    if (!widget.isDestroyed() && !widget.isVisible()) widget.show();
  });

  widget.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (url !== WIDGET_URL) return;
    // Dev server probably isn't ready yet — retry with backoff up to ~10s.
    setTimeout(() => {
      if (!loaded && widget && !widget.isDestroyed()) widget.loadURL(WIDGET_URL);
    }, 500);
  });

  // When the widget gets bounced to /login (or similar full-page route),
  // expand to panel size so the form is usable. When it lands back on
  // /widget proper, the renderer JS controls the size via IPC.
  widget.webContents.on("did-navigate", (_e, url) => {
    if (!url) return;
    const path = new URL(url).pathname;
    if (path.startsWith("/login") || path.startsWith("/signup")) {
      setSize(PANEL);
    }
  });

  widget.loadURL(WIDGET_URL);

  widget.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      widget.hide();
    }
  });
}

function buildTray() {
  let icon;
  try {
    icon = nativeImage.createFromPath(path.join(__dirname, "assets", "icon.png"));
    if (icon.isEmpty()) throw new Error("empty");
    icon = icon.resize({ width: 18, height: 18 });
  } catch {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip("Scaled Operations");

  const menu = Menu.buildFromTemplate([
    { label: "Show widget", click: () => widget?.show() },
    { label: "Hide widget", click: () => widget?.hide() },
    { type: "separator" },
    { label: "Collapse to bubble", click: () => { setSize(BUBBLE); widget?.webContents.send("widget:set-expanded", false); } },
    { label: "Expand", click: () => { setSize(PANEL); widget?.webContents.send("widget:set-expanded", true); } },
    { type: "separator" },
    { label: "Open full app", click: () => shell.openExternal(APP_URL) },
    { type: "separator" },
    // Notification helpers — added in v0.1.2 so Mac users can verify the
    // permission grant and jump to system settings without hunting.
    {
      label: "Test notification",
      click: () => {
        const ok = showNotification({
          title: "Scaled Operations",
          body: "Notifications are working. You'll get pinged for mentions, kudos, emails, and EOD reminders.",
          silent: false
        });
        // On the very first invocation macOS pops the permission prompt
        // BEFORE the notification renders — the user grants once, then
        // subsequent clicks pop the actual toast. Log so a diagnosing
        // engineer can tell which path fired from the widget dev console.
        console.log("[notify] test click delivered=" + ok);
      }
    },
    {
      label: "Notification settings…",
      click: () => {
        // Deep-link straight into the OS Notifications pane so the user
        // can flip permission if they hit "Don't allow" earlier.
        if (process.platform === "darwin") {
          shell.openExternal("x-apple.systempreferences:com.apple.preference.notifications");
        } else if (process.platform === "win32") {
          shell.openExternal("ms-settings:notifications");
        } else {
          shell.openExternal(APP_URL);
        }
      }
    },
    { type: "separator" },
    {
      label: "Reload widget",
      click: () => widget?.webContents.reloadIgnoringCache()
    },
    {
      label: "Toggle DevTools",
      click: () => {
        if (!widget) return;
        widget.webContents.isDevToolsOpened()
          ? widget.webContents.closeDevTools()
          : widget.webContents.openDevTools({ mode: "detach" });
      }
    },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } }
  ]);

  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (!widget) return;
    widget.isVisible() ? widget.hide() : widget.show();
  });
}

app.whenReady().then(() => {
  // Brand Windows toast notifications and make their click activation reliable
  // when running unpackaged (`npm run electron`). Must match the electron-builder
  // appId; packaged builds set this automatically.
  if (process.platform === "win32") app.setAppUserModelId("com.scaledai.delegationdoer");

  createWidget();
  buildTray();

  // macOS-only permission priming. The very first Notification.show() on
  // Mac triggers the "Allow Scaled Operations to send notifications?"
  // dialog. Firing a bare, silent, no-body priming notification a couple
  // seconds after boot gets the dialog in front of the user immediately
  // (instead of waiting until the first real mention/kudos/email lands
  // and possibly getting missed). Wrapped in try/catch so a boot-time
  // failure never blocks the widget itself. Windows toasts don't need
  // priming — permission is granted per-app-manifest at install time.
  if (process.platform === "darwin") {
    setTimeout(() => {
      try {
        if (Notification.isSupported()) {
          const primer = new Notification({
            title: "Scaled Operations",
            body: "Notifications enabled — you'll be pinged for mentions, kudos, and reminders.",
            silent: true
          });
          primer.show();
        }
      } catch (err) {
        console.error("[notify] mac permission priming failed", err);
      }
    }, 2500);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWidget();
  });
});

ipcMain.handle("widget:expand", () => setSize(PANEL));
ipcMain.handle("widget:collapse", () => setSize(BUBBLE));
ipcMain.handle("widget:set-state", (_e, state) => setSize(sizeForState(state)));

// Fit the notification window to the exact card height the renderer measured,
// so the whole alert pops complete — no center-clipping — no matter how many
// mentions/emails stack up. Width stays at the ALERT default; only height is
// content-driven, clamped to the current display's work area. This is pure
// BrowserWindow bounds math, so the behaviour is identical on macOS and
// Windows. Ignored (harmless) if called in any non-alert state.
ipcMain.handle("widget:set-alert-size", (_e, size) => {
  if (!widget) return;
  const wa = currentDisplay().workArea;
  const h = Math.max(BUBBLE.h, Math.min(Math.round((size && size.h) || ALERT.h), wa.height - MARGIN * 2));
  const a = getAnchors({ w: ALERT.w, h })[currentAnchor] || getAnchors({ w: ALERT.w, h }).br;
  widget.setBounds({ x: a.x, y: a.y, width: ALERT.w, height: h }, false);
});
ipcMain.handle("widget:hide", () => widget?.hide());
ipcMain.handle("widget:openMain", () => shell.openExternal(APP_URL));
ipcMain.handle("widget:openMainWindow", (_e, path) => {
  const dest = typeof path === "string" && path.startsWith("/") ? APP_URL + path : APP_URL;
  shell.openExternal(dest);
});

// OS-level notifications. The renderer owns the "what's fresh" dedup and
// fires one of these per new task / mention / email.
//
// v0.1.2 change: unify Mac + Windows on Electron's native Notification API.
// Modern Electron (>=20) delivers reliably on unsigned Mac apps too, as long
// as macOS has granted permission (auto-prompted the first time a
// notification is shown from our app bundle). node-notifier stays as a
// last-ditch fallback for the case where isSupported() returns false —
// should never happen in practice, but keeps us from silent-failing if it
// does. The renderer plays its own chime, so we ask the OS to be silent.
// `path` is an optional app-relative route (e.g. an inbox deep link). When
// present, clicking the notification opens it in the default browser.
function showNotification({ title, body, path, silent = true } = {}) {
  const url = typeof path === "string" && path.startsWith("/") ? APP_URL + path : null;
  const platform = process.platform;

  if (Notification.isSupported()) {
    try {
      const n = new Notification({ title, body, silent });
      if (url) n.on("click", () => shell.openExternal(url));
      n.on("failed", (_e, err) => {
        console.error(`[notify] native failed (${platform})`, err);
      });
      n.show();
      console.log(`[notify] native → ${platform}: ${title}`);
      return true;
    } catch (err) {
      console.error(`[notify] native threw (${platform}), falling back`, err);
    }
  } else {
    console.warn(`[notify] Notification.isSupported() false on ${platform}`);
  }

  // Fallback: node-notifier (mac helper binary bundled via electron-builder).
  // Only reached when the native path is unavailable or throws.
  if (platform === "darwin") {
    try {
      const notifier = require("node-notifier");
      notifier.notify({ title, message: body, sound: false, ...(url ? { open: url } : {}) });
      console.log(`[notify] node-notifier fallback → darwin: ${title}`);
      return true;
    } catch (err) {
      console.error("[notify] node-notifier fallback failed", err);
    }
  }
  return false;
}

ipcMain.handle("widget:notify", (_e, payload) => {
  showNotification(payload || {});
});

// Drag pipeline. Renderer sends absolute screen coords.
ipcMain.on("widget:drag-start", (_e, sx, sy) => {
  if (!widget) return;
  const [wx, wy] = widget.getPosition();
  dragOffset = { x: sx - wx, y: sy - wy };
});
ipcMain.on("widget:drag-move", (_e, sx, sy) => {
  if (!widget || !dragOffset) return;
  widget.setPosition(Math.round(sx - dragOffset.x), Math.round(sy - dragOffset.y), false);
});
ipcMain.on("widget:drag-end", () => {
  if (!dragOffset) return;
  dragOffset = null;
  snapToNearestAnchor();
});

app.on("window-all-closed", (e) => e.preventDefault());

// Bubble-style widget with drag-to-snap.
//
// - Window starts at 64x64 in the bottom-right corner, transparent, always-on-top.
// - Click the bubble to expand into the 380x520 panel from the same anchor.
// - Drag the bubble: it tracks the cursor; on release, it snaps to the nearest
//   of 8 anchors (4 corners + 4 edge midpoints) on whichever display it's on.
// - That anchor is remembered, so collapse/expand keeps the same corner/edge.

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, shell, Notification } = require("electron");
const notifier = require("node-notifier");
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
const ALERT  = { w: 420, h: 140 };
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
  tray.setToolTip("DelegationDoer");

  const menu = Menu.buildFromTemplate([
    { label: "Show widget", click: () => widget?.show() },
    { label: "Hide widget", click: () => widget?.hide() },
    { type: "separator" },
    { label: "Collapse to bubble", click: () => { setSize(BUBBLE); widget?.webContents.send("widget:set-expanded", false); } },
    { label: "Expand", click: () => { setSize(PANEL); widget?.webContents.send("widget:set-expanded", true); } },
    { type: "separator" },
    { label: "Open full app", click: () => shell.openExternal(APP_URL) },
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
  createWidget();
  buildTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWidget();
  });
});

ipcMain.handle("widget:expand", () => setSize(PANEL));
ipcMain.handle("widget:collapse", () => setSize(BUBBLE));
ipcMain.handle("widget:set-state", (_e, state) => setSize(sizeForState(state)));
ipcMain.handle("widget:hide", () => widget?.hide());
ipcMain.handle("widget:openMain", () => shell.openExternal(APP_URL));
ipcMain.handle("widget:openMainWindow", (_e, path) => {
  const dest = typeof path === "string" && path.startsWith("/") ? APP_URL + path : APP_URL;
  shell.openExternal(dest);
});

// OS-level notifications. The renderer owns the "what's fresh" dedup and
// fires one of these per new task / mention / email. macOS silently drops
// Electron's native Notification from an unsigned app, so route through
// node-notifier there (it ships a signed terminal-notifier helper that
// delivers regardless of our app's signature). Native Notification is fine
// on Windows. The renderer plays its own chime, so keep these silent.
// `path` is an optional app-relative route (e.g. an inbox deep link). When
// present, clicking the notification opens it in the default browser — native
// `click` event on Windows, node-notifier's `open` option on macOS.
ipcMain.handle("widget:notify", (_e, { title, body, path }) => {
  const url = typeof path === "string" && path.startsWith("/") ? APP_URL + path : null;
  if (process.platform === "darwin") {
    notifier.notify({ title, message: body, sound: false, ...(url ? { open: url } : {}) });
  } else if (Notification.isSupported()) {
    const n = new Notification({ title, body });
    if (url) n.on("click", () => shell.openExternal(url));
    n.show();
  }
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

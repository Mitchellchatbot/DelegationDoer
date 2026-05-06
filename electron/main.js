// Bubble-style widget with drag-to-snap.
//
// - Window starts at 64x64 in the bottom-right corner, transparent, always-on-top.
// - Click the bubble to expand into the 380x520 panel from the same anchor.
// - Drag the bubble: it tracks the cursor; on release, it snaps to the nearest
//   of 8 anchors (4 corners + 4 edge midpoints) on whichever display it's on.
// - That anchor is remembered, so collapse/expand keeps the same corner/edge.

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, shell, Notification } = require("electron");
const path = require("path");

const APP_URL = process.env.DD_APP_URL || "http://localhost:3000";
const WIDGET_URL = `${APP_URL}/widget`;

// 88x88 collapsed window with the 64x64 icon centered inside. The 12-px
// transparent margin around the icon prevents macOS from painting a default
// opaque backdrop at the icon's edge — that "white squircle" effect.
const BUBBLE = { w: 88, h: 88 };
const ALERT  = { w: 380, h: 100 };
const PANEL  = { w: 380, h: 520 };
const MARGIN = 16;

function sizeForState(state) {
  return state === "panel" ? PANEL : state === "alert" ? ALERT : BUBBLE;
}

const ANCHOR_NAMES = ["tl", "tc", "tr", "ml", "mr", "bl", "bc", "br"];
let currentAnchor = "br";

let widget = null;
let tray = null;
let lastTicketIds = new Set();
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
      nodeIntegration: false
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
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } }
  ]);

  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (!widget) return;
    widget.isVisible() ? widget.hide() : widget.show();
  });
}

async function pollAssignments() {
  try {
    const res = await fetch(`${APP_URL}/api/widget/my-tickets`);
    if (!res.ok) return;
    const data = await res.json();
    const ids = new Set(data.tickets.map((t) => t.id));

    if (lastTicketIds.size > 0) {
      for (const t of data.tickets) {
        if (!lastTicketIds.has(t.id)) {
          new Notification({ title: "New ticket assigned", body: t.title }).show();
        }
      }
    }
    lastTicketIds = ids;

    if (widget && !widget.isDestroyed()) {
      widget.webContents.send("widget:tickets", data.tickets);
    }
  } catch {
    // App not running yet; silent.
  }
}

app.whenReady().then(() => {
  createWidget();
  buildTray();
  pollAssignments();
  setInterval(pollAssignments, 60_000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWidget();
  });
});

ipcMain.handle("widget:expand", () => setSize(PANEL));
ipcMain.handle("widget:collapse", () => setSize(BUBBLE));
ipcMain.handle("widget:set-state", (_e, state) => setSize(sizeForState(state)));
ipcMain.handle("widget:hide", () => widget?.hide());
ipcMain.handle("widget:openMain", () => shell.openExternal(APP_URL));
ipcMain.handle("widget:poll", () => pollAssignments());

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

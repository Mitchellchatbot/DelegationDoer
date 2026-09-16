// The email composer's formatting vocabulary — Gmail's fonts, sizes and
// palette — and the canonicalizers that map any incoming style value (a
// pasted Google Doc, a Word document, a saved draft) onto it. Pure (no DOM):
// shared by the editor's schema and the HTML serializer.
//
// Anything that maps to the default (Sans Serif, Normal size, black text, no
// highlight) becomes null, so pasted documents don't drag their "Arial 11pt
// black" into outgoing mail and a plain email stays plain.

export interface FontOption {
  key: string;
  label: string;
  css: string | null; // null = the default font
}

export const FONT_FAMILIES: readonly FontOption[] = [
  { key: "sans", label: "Sans Serif", css: null },
  { key: "serif", label: "Serif", css: "times new roman,serif" },
  { key: "fixed", label: "Fixed Width", css: "monospace,monospace" },
  { key: "wide", label: "Wide", css: "arial black,sans-serif" },
  { key: "narrow", label: "Narrow", css: "arial narrow,sans-serif" },
  { key: "comic", label: "Comic Sans MS", css: "comic sans ms,sans-serif" },
  { key: "garamond", label: "Garamond", css: "garamond,times new roman,serif" },
  { key: "georgia", label: "Georgia", css: "georgia,serif" },
  { key: "tahoma", label: "Tahoma", css: "tahoma,sans-serif" },
  { key: "trebuchet", label: "Trebuchet MS", css: "trebuchet ms,sans-serif" },
  { key: "verdana", label: "Verdana", css: "verdana,sans-serif" }
];

// First family named in a font-family value → option. Common UI and document
// defaults count as Sans Serif.
const FONT_ALIASES: Record<string, string> = {
  arial: "sans", helvetica: "sans", "helvetica neue": "sans", "sans-serif": "sans", "system-ui": "sans",
  "-apple-system": "sans", blinkmacsystemfont: "sans", "segoe ui": "sans", roboto: "sans", calibri: "sans",
  aptos: "sans", inter: "sans", "open sans": "sans", "google sans": "sans",
  "times new roman": "serif", times: "serif", serif: "serif", cambria: "serif",
  "courier new": "fixed", courier: "fixed", monospace: "fixed", consolas: "fixed", menlo: "fixed",
  "arial black": "wide", "arial narrow": "narrow", "comic sans ms": "comic", garamond: "garamond",
  georgia: "georgia", tahoma: "tahoma", "trebuchet ms": "trebuchet", verdana: "verdana"
};

// Pasted style values are arbitrary strings; "constructor" must not find
// Object.prototype.
function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function fontOptionFor(value: string | null | undefined): FontOption {
  const first = (value ?? "").split(",")[0].replace(/["']/g, "").trim().toLowerCase();
  const key = lookup(FONT_ALIASES, first) ?? "sans";
  return FONT_FAMILIES.find((f) => f.key === key) ?? FONT_FAMILIES[0];
}

export function canonicalFontFamily(value: string | null | undefined): string | null {
  return fontOptionFor(value).css;
}

export interface SizeOption {
  key: string;
  label: string;
  css: string | null; // null = normal
}

export const FONT_SIZES: readonly SizeOption[] = [
  { key: "small", label: "Small", css: "10px" },
  { key: "normal", label: "Normal", css: null },
  { key: "large", label: "Large", css: "18px" },
  { key: "huge", label: "Huge", css: "32px" }
];

const KEYWORD_PX: Record<string, number> = {
  "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32, "xxx-large": 48
};

// HTML's legacy <font size=1..7>.
const LEGACY_FONT_SIZE_PX: Record<string, number> = { "1": 10, "2": 13, "3": 16, "4": 18, "5": 24, "6": 32, "7": 48 };

export function legacyFontSizePx(size: string | null | undefined): number | undefined {
  return lookup(LEGACY_FONT_SIZE_PX, (size ?? "").trim());
}

const UNIT_PX: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, em: 16, rem: 16 };

// A CSS length in px ("0.5in", ".5in", "36pt", "2em"; a bare number is px).
export function cssLengthPx(value: string | null | undefined): number | null {
  const m = /^(\d*\.?\d+)(px|pt|pc|in|cm|mm|em|rem)?$/.exec((value ?? "").trim().toLowerCase());
  return m ? parseFloat(m[1]) * UNIT_PX[m[2] ?? "px"] : null;
}

function fontSizePx(value: string): number | null {
  const v = value.trim().toLowerCase();
  const keyword = lookup(KEYWORD_PX, v);
  if (keyword !== undefined) return keyword;
  const percent = /^(\d*\.?\d+)%$/.exec(v);
  if (percent) return (parseFloat(percent[1]) / 100) * 16;
  return cssLengthPx(v);
}

export function sizeOptionFor(value: string | null | undefined): SizeOption {
  const px = value ? fontSizePx(value) : null;
  const key = px === null ? "normal" : px <= 11.5 ? "small" : px <= 16.5 ? "normal" : px <= 24 ? "large" : "huge";
  return FONT_SIZES.find((s) => s.key === key) ?? FONT_SIZES[1];
}

export function canonicalFontSize(value: string | null | undefined): string | null {
  return sizeOptionFor(value).css;
}

// Google's 8×8 palette, as in Gmail and Docs.
export const PALETTE: readonly string[] = [
  "#000000", "#444444", "#666666", "#999999", "#cccccc", "#eeeeee", "#f3f3f3", "#ffffff",
  "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#9900ff", "#ff00ff",
  "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#cfe2f3", "#d9d2e9", "#ead1dc",
  "#ea9999", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#9fc5e8", "#b4a7d6", "#d5a6bd",
  "#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6fa8dc", "#8e7cc3", "#c27ba0",
  "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3d85c6", "#674ea7", "#a64d79",
  "#990000", "#b45f06", "#bf9000", "#38761d", "#134f5c", "#0b5394", "#351c75", "#741b47",
  "#660000", "#783f04", "#7f6000", "#274e13", "#0c343d", "#073763", "#20124d", "#4c1130"
];

// CSS basic names plus Word/Outlook's highlight colors.
const NAMED_COLORS: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  orange: "#ffa500", purple: "#800080", gray: "#808080", grey: "#808080", navy: "#000080", teal: "#008080",
  lime: "#00ff00", aqua: "#00ffff", cyan: "#00ffff", fuchsia: "#ff00ff", magenta: "#ff00ff", maroon: "#800000",
  olive: "#808000", silver: "#c0c0c0", darkblue: "#00008b", darkred: "#8b0000", darkgreen: "#006400",
  darkgray: "#a9a9a9", darkgrey: "#a9a9a9", lightgray: "#d3d3d3", lightgrey: "#d3d3d3"
};

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

// "#rgb", "#rrggbb", "#rrggbbaa", "rgb(r, g, b)", "rgb(r g b / a)", a name →
// "#rrggbb"; null for anything else or (nearly) transparent.
function toHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  const named = lookup(NAMED_COLORS, v);
  if (named) return named;
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return "#" + m[1].split("").map((c) => c + c).join("");
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) return m[2] !== undefined && parseInt(m[2], 16) / 255 < 0.1 ? null : `#${m[1]}`;
  m = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*(\d*\.?\d+)(%?)\s*)?\)$/.exec(v);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) / (m[5] ? 100 : 1) < 0.1) return null;
    return "#" + [m[1], m[2], m[3]].map((n) => hex2(parseInt(n, 10))).join("");
  }
  return null;
}

function rgbOf(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

// Text color: near-black is just the default text color.
export function canonicalTextColor(value: string | null | undefined): string | null {
  const hex = typeof value === "string" ? toHex(value) : null;
  if (!hex) return null;
  const [r, g, b] = rgbOf(hex);
  return r <= 0x33 && g <= 0x33 && b <= 0x33 ? null : hex;
}

// Highlight: white or near-white is no highlight.
export function canonicalBackgroundColor(value: string | null | undefined): string | null {
  const hex = typeof value === "string" ? toHex(value) : null;
  if (!hex) return null;
  const [r, g, b] = rgbOf(hex);
  return r >= 0xf8 && g >= 0xf8 && b >= 0xf8 ? null : hex;
}

// Text too light to read on a white page.
export function isNearWhite(hex: string): boolean {
  const [r, g, b] = rgbOf(hex);
  return r >= 0xe0 && g >= 0xe0 && b >= 0xe0;
}

export const INDENT_STEP_PX = 40;
export const MAX_INDENT = 8;

export function indentFromMarginLeft(value: string | null | undefined): number {
  const px = cssLengthPx(value);
  return px === null ? 0 : Math.max(0, Math.min(MAX_INDENT, Math.round(px / INDENT_STEP_PX)));
}

export const ALIGNMENTS = ["left", "center", "right"] as const;

// Gmail's quote bar, inline (mail clients drop classes). Deliberately no
// gmail_quote class: that marks quoted history, which readers collapse.
export const QUOTE_STYLE = "margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex";

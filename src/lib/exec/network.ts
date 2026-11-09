import { createHash } from "node:crypto";
import { isIP } from "node:net";

// P8 new-network alerts (contract §3.19, M13, C20; Area B; pure, B-P8-5): the network prefix and the coarse user-agent
// family a strong web session is keyed by. node:net and node:crypto only. Neither output carries the full address or the
// user agent: a /24 or /48 prefix and a "<browser>-<os>" pair are the only forms that leave exec_access_log (§0.3 rule 4).

const HEX4 = /^[0-9a-f]{1,4}$/;

/** "x:y::z" (an optional zone id and a dotted IPv4 tail allowed; already valid per isIP) → its eight 16-bit groups, or null. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    if (isIP(last) !== 4) return null;
    const [a, b, c, d] = last.split(".").map(Number);
    tail = [(a << 8) | b, (c << 8) | d];
    // "::ffff:" → "::ffff", "::" stays "::", "1:2:3:4:5:6:" → "1:2:3:4:5:6": drop only the separator before the IPv4 part.
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith("::")) s = s.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!HEX4.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || rest === null) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 && known !== 8) return null;
  if (known > 8) return null;
  const fill = halves.length === 2 ? new Array<number>(8 - known).fill(0) : [];
  const groups = [...head, ...fill, ...rest, ...tail];
  return groups.length === 8 ? groups : null;
}

/** IPv4 → "a.b.c.0/24"; IPv6 (expanded) → first three hextets + "::/48"; IPv4-mapped IPv6 → its IPv4 /24; invalid/null → null. */
export function ipNetwork(ip: string | null): string | null {
  if (typeof ip !== "string") return null;
  const s = ip.trim();
  const kind = isIP(s);
  if (kind === 4) {
    const [a, b, c] = s.split(".").map(Number);
    return `${a}.${b}.${c}.0/24`;
  }
  if (kind !== 6) return null;
  const g = ipv6Groups(s);
  if (g === null) return null;
  // ::ffff:a.b.c.d (and its hex spelling ::ffff:abcd:ef01): the client is the IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.0/24`;
  return `${g[0].toString(16)}:${g[1].toString(16)}:${g[2].toString(16)}::/48`;
}

/** Coarse "<browser>-<os>": browser edge|chrome|firefox|safari|other (order: Edg/ before Chrome/; Safari only without Chrome);
 *  os windows|mac|ios|android|linux|other. Null → "other-other". */
export function uaFamily(ua: string | null): string {
  if (typeof ua !== "string" || ua.trim() === "") return "other-other";
  const browser =
    /\bEdg(?:e|A|iOS)?\//.test(ua) ? "edge"
      : /\b(?:Firefox|FxiOS)\//.test(ua) ? "firefox"
        : /\b(?:Chrome|CriOS|Chromium)\//.test(ua) ? "chrome"
          : /\bSafari\//.test(ua) ? "safari"
            : "other";
  const os =
    /\bWindows\b/.test(ua) ? "windows"
      : /\b(?:iPhone|iPad|iPod)\b/.test(ua) ? "ios"
        : /\bAndroid\b/.test(ua) ? "android"
          : /\b(?:Macintosh|Mac OS X)\b/.test(ua) ? "mac"
            : /\b(?:Linux|X11|CrOS)\b/.test(ua) ? "linux"
              : "other";
  return `${browser}-${os}`;
}

/** sha256 hex of the network, first 16 (the dedupe key part). */
export function networkKeyHash(net: string): string {
  return createHash("sha256").update(String(net), "utf8").digest("hex").slice(0, 16);
}

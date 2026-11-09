import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ipNetwork, networkKeyHash, uaFamily } from "@/lib/exec/network";

// P8 contract §5.15 NA02-NA03 (M13, C20): the network prefix and the user-agent family a strong session is keyed by.

describe("ipNetwork", () => {
  it("NA02 IPv4 → its /24", () => {
    expect(ipNetwork("203.0.113.77")).toBe("203.0.113.0/24");
    expect(ipNetwork(" 198.51.100.1 ")).toBe("198.51.100.0/24");
    expect(ipNetwork("10.0.0.255")).toBe("10.0.0.0/24");
  });

  it("NA02 IPv6 → its first three hextets as a /48, expanded and lowercased", () => {
    expect(ipNetwork("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
    expect(ipNetwork("2001:DB8:1234:5678:9abc:def0:1:2")).toBe("2001:db8:1234::/48");
    expect(ipNetwork("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(ipNetwork("2001:0db8:0000:ffff::")).toBe("2001:db8:0::/48");
    expect(ipNetwork("fe80::1%eth0")).toBe("fe80:0:0::/48");
    expect(ipNetwork("2001:db8:1:2:3:4:192.0.2.33")).toBe("2001:db8:1::/48");
  });

  it("NA02 an IPv4-mapped IPv6 address → its IPv4 /24 (dotted or hex)", () => {
    expect(ipNetwork("::ffff:203.0.113.9")).toBe("203.0.113.0/24");
    expect(ipNetwork("::FFFF:203.0.113.9")).toBe("203.0.113.0/24");
    expect(ipNetwork("::ffff:cb00:7109")).toBe("203.0.113.0/24");
    // Not mapped: an IPv4-compatible or a NAT64 address stays IPv6.
    expect(ipNetwork("64:ff9b::203.0.113.9")).toBe("64:ff9b:0::/48");
  });

  it("NA02 ::1 is handled (loopback: the all-zero /48)", () => {
    expect(ipNetwork("::1")).toBe("0:0:0::/48");
    expect(ipNetwork("::")).toBe("0:0:0::/48");
  });

  it("NA02 anything else → null", () => {
    for (const bad of [null, "", " ", "not-an-ip", "203.0.113", "203.0.113.256", "2001:db8::1::2", "[2001:db8::1]", "1.2.3.4:443", "1.2.3.4/24", "2001:db8:::1"]) {
      expect(ipNetwork(bad), String(bad)).toBeNull();
    }
    expect(ipNetwork(12 as unknown as string)).toBeNull();
  });
});

describe("uaFamily", () => {
  const UA = {
    edgeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68",
    chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    safariIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
    safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
    firefoxIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15",
    edgeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.2849.68",
    firefoxWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    curl: "curl/8.7.1"
  };

  it("NA03 recorded user agents: Edge on Windows, Chrome on macOS, Safari on iOS, Firefox on Linux", () => {
    expect(uaFamily(UA.edgeWindows)).toBe("edge-windows");
    expect(uaFamily(UA.chromeMac)).toBe("chrome-mac");
    expect(uaFamily(UA.safariIos)).toBe("safari-ios");
    expect(uaFamily(UA.firefoxLinux)).toBe("firefox-linux");
  });

  it("NA03 Edg/ is checked before Chrome/; Safari only without Chrome; iOS and Android before mac and linux", () => {
    expect(uaFamily(UA.safariMac)).toBe("safari-mac");
    expect(uaFamily(UA.chromeAndroid)).toBe("chrome-android");
    expect(uaFamily(UA.chromeIos)).toBe("chrome-ios");
    expect(uaFamily(UA.firefoxIos)).toBe("firefox-ios");
    expect(uaFamily(UA.edgeAndroid)).toBe("edge-android");
    expect(uaFamily(UA.firefoxWindows)).toBe("firefox-windows");
    expect(uaFamily(UA.curl)).toBe("other-other");
  });

  it("NA03 garbage and null → other-other", () => {
    // A control character (U+0000), built from its code point.
    for (const ua of [null, "", "   ", "garbage", String.fromCodePoint(0)]) expect(uaFamily(ua)).toBe("other-other");
  });

  it("only ever answers one of the 30 coarse families (never any part of the user agent)", () => {
    const FAMILY = /^(?:edge|chrome|firefox|safari|other)-(?:windows|mac|ios|android|linux|other)$/;
    for (const ua of [...Object.values(UA), "Mozilla/5.0 (SENTINEL_BRIEF_LINE_7Q) Chrome/1.0", "x".repeat(5_000)]) expect(uaFamily(ua)).toMatch(FAMILY);
  });
});

describe("networkKeyHash", () => {
  it("is the first 16 hex characters of sha256(network)", () => {
    const net = "203.0.113.0/24";
    expect(networkKeyHash(net)).toBe(createHash("sha256").update(net).digest("hex").slice(0, 16));
    expect(networkKeyHash(net)).toMatch(/^[0-9a-f]{16}$/);
    expect(networkKeyHash("2001:db8:1234::/48")).not.toBe(networkKeyHash(net));
  });
});

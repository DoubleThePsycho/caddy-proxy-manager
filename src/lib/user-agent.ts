/**
 * A best-effort description of the device behind a User-Agent string, for
 * the list of signed-in sessions: browser, operating system and kind of
 * device. Only well-known tokens are matched; anything else is "Unknown".
 * Pure and dependency-free, so client and server agree.
 */

export type DeviceKind = "desktop" | "mobile" | "tablet" | "unknown";

export type DeviceInfo = {
  browser: string | null;
  os: string | null;
  kind: DeviceKind;
  /** "Firefox on Linux", "Safari on iOS", or "Unknown device". */
  label: string;
};

/** Longer than any real User-Agent; the rest is ignored. */
const MAX_LENGTH = 512;

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bVivaldi\//, "Vivaldi"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\//, "Chrome"],
  [/\bChrom(?:e|ium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
  [/\bcurl\//, "curl"],
  [/\bWget\//, "Wget"],
  [/\bPython-urllib\/|\bpython-requests\//, "Python"],
  [/\bGo-http-client\//, "Go"],
  [/\bnode-fetch\b|\bundici\b|^node\b/i, "Node.js"],
  [/\bPostmanRuntime\//, "Postman"],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/\bWindows Phone\b/, "Windows Phone"],
  [/\bWindows\b/, "Windows"],
  [/\b(?:iPhone|iPad|iPod)\b|\biOS\b/, "iOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

export function parseUserAgent(raw: string | null | undefined): DeviceInfo {
  const ua = typeof raw === "string" ? raw.slice(0, MAX_LENGTH) : "";
  if (!ua.trim()) return { browser: null, os: null, kind: "unknown", label: "Unknown device" };

  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const os = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;

  let kind: DeviceKind = "unknown";
  if (/\biPad\b|\bTablet\b/.test(ua) || (os === "Android" && !/\bMobile\b/.test(ua))) kind = "tablet";
  else if (/\bMobile\b|\biPhone\b|\biPod\b|\bWindows Phone\b/.test(ua)) kind = "mobile";
  else if (os === "Windows" || os === "macOS" || os === "Linux" || os === "ChromeOS") kind = "desktop";

  const label = browser && os ? `${browser} on ${os}` : browser ?? (os ? `Browser on ${os}` : "Unknown device");
  return { browser, os, kind, label };
}

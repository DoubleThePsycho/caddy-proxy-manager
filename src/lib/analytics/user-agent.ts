/**
 * User-agent family: a short, stable name for a User-Agent header, so the
 * analytics can count and filter "Chrome · Windows" or "curl 8.5" instead of
 * thousands of distinct strings. Computed once when a request is ingested
 * (log-parser.ts) and stored in traffic_events.ua_family.
 *
 * - No header: "(none)".
 * - Browsers: "<browser> · <system>", without versions ("Chrome · Windows").
 * - Crawlers, tools and apps: "<product> <version>" from the header's first
 *   product token or its bot token ("Googlebot 2.1", "curl 8.5.0").
 * - Anything else: the start of the header.
 */

export const UA_FAMILY_MAX_LENGTH = 64;
export const UA_NONE = '(none)';

/** Keeps at most three dot-separated version components. */
function shortVersion(version: string): string {
  return version.split('.').slice(0, 3).join('.');
}

function browserSystem(ua: string): string | null {
  if (/\b(iPhone|iPod)\b/.test(ua)) return 'iOS';
  if (/\biPad\b/.test(ua)) return 'iPadOS';
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
  if (/\bWindows (NT|Phone)\b/.test(ua)) return 'Windows';
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS';
  if (/\bLinux\b|\bX11\b/.test(ua)) return 'Linux';
  return null;
}

function browserName(ua: string): string | null {
  if (/\bEdg(A|iOS|e)?\//.test(ua)) return 'Edge';
  if (/\bOPR\/|\bOpera\b/.test(ua)) return 'Opera';
  if (/\bSamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/\bYaBrowser\//.test(ua)) return 'Yandex Browser';
  if (/\b(Firefox|FxiOS)\//.test(ua)) return 'Firefox';
  if (/\b(Chrome|CriOS|Chromium)\//.test(ua)) return 'Chrome';
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(ua)) return 'Safari';
  return null;
}

const BOT_TOKEN = /([A-Za-z][\w.-]*?(?:bot|crawler|spider|scanner|fetcher|archiver))\/v?(\d[\w.]*)/i;
const PRODUCT_TOKEN = /^([A-Za-z][\w.+-]{0,48})\/v?(\d[\w.-]*)/;

/** The family of a User-Agent header (see the module comment). */
export function userAgentFamily(raw: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  const ua = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!ua) return UA_NONE;

  const otel = /^OTel-OTLP-Exporter-([A-Za-z]+)\/(\d+(?:\.\d+)?)/.exec(ua);
  if (otel) return cap(`OTel exporter · ${otel[1]} ${otel[2]}`);

  // Exchange ActiveSync clients of Apple devices: "Apple-iPhone14C5/2101.329".
  const activeSync = /^Apple-(iPhone|iPad|iPod)/.exec(ua);
  if (activeSync) return `${activeSync[1]} Mail`;

  const bot = BOT_TOKEN.exec(ua);
  if (bot) return cap(`${bot[1]} ${shortVersion(bot[2])}`);

  if (/^Mozilla\/\d/.test(ua)) {
    const browser = browserName(ua);
    const system = browserSystem(ua);
    if (browser && system) return `${browser} · ${system}`;
    if (browser) return browser;
    if (system) return `Other browser · ${system}`;
  }

  const product = PRODUCT_TOKEN.exec(ua);
  if (product && product[1] !== 'Mozilla') return cap(`${product[1]} ${shortVersion(product[2])}`);

  return cap(ua.split(/\s+/)[0] ?? ua);
}

function cap(value: string): string {
  return value.length > UA_FAMILY_MAX_LENGTH ? value.slice(0, UA_FAMILY_MAX_LENGTH) : value;
}

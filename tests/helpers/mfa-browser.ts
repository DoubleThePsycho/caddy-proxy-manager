/**
 * A minimal cookie-keeping client for Better Auth's HTTP handler, and TOTP
 * helpers, for the dashboard MFA tests.
 */
import { createOTP } from '@better-auth/utils/otp';
import { base32 } from '@better-auth/utils/base32';

export const APP_BASE_URL = 'http://localhost:3000';

type Handler = (request: Request) => Promise<Response>;

export type HttpResult = { status: number; body: any; setCookies: string[] };

export class AuthBrowser {
  readonly cookies = new Map<string, string>();

  constructor(private readonly handler: () => Handler) {}

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** The cookie names this browser holds. */
  has(fragment: string): boolean {
    return [...this.cookies.keys()].some((name) => name.includes(fragment));
  }

  headers(): Headers {
    const headers = new Headers({ origin: APP_BASE_URL });
    const cookie = this.cookieHeader();
    if (cookie) headers.set('cookie', cookie);
    return headers;
  }

  async post(path: string, body: Record<string, unknown> = {}): Promise<HttpResult> {
    const headers = this.headers();
    headers.set('content-type', 'application/json');
    const res = await this.handler()(new Request(`${APP_BASE_URL}/api/auth${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }));
    const setCookies = res.headers.getSetCookie();
    this.absorb(setCookies);
    return { status: res.status, body: await res.json().catch(() => null), setCookies };
  }

  /**
   * A form POST as an identity provider makes the browser send it: from the
   * IdP's origin, with this browser's cookies. Redirects are not followed.
   */
  async postForm(path: string, form: Record<string, string>, origin = 'https://idp.example.com'): Promise<HttpResult & { location: string | null }> {
    const headers = this.headers();
    headers.set('origin', origin);
    headers.set('content-type', 'application/x-www-form-urlencoded');
    const res = await this.handler()(new Request(`${APP_BASE_URL}/api/auth${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
    }));
    const setCookies = res.headers.getSetCookie();
    this.absorb(setCookies);
    return { status: res.status, body: await res.text().catch(() => null), setCookies, location: res.headers.get('location') };
  }

  /** A GET; redirects are not followed (`location` is where one points). */
  async get(path: string): Promise<HttpResult & { contentType: string | null; location: string | null }> {
    const res = await this.handler()(new Request(`${APP_BASE_URL}/api/auth${path}`, { method: 'GET', headers: this.headers() }));
    const setCookies = res.headers.getSetCookie();
    this.absorb(setCookies);
    return {
      status: res.status,
      body: await res.text().catch(() => null),
      setCookies,
      contentType: res.headers.get('content-type'),
      location: res.headers.get('location'),
    };
  }

  private absorb(setCookies: string[]): void {
    for (const line of setCookies) {
      const [pair, ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

/** The raw TOTP secret in an otpauth:// URI, as Better Auth's OTP helper takes it. */
export function totpSecretFromUri(uri: string): string {
  const encoded = new URL(uri).searchParams.get('secret');
  if (!encoded) throw new Error('no secret in the TOTP URI');
  return new TextDecoder().decode(base32.decode(encoded));
}

/** The code for the time step `offset` steps away from now. */
export function totpCode(secret: string, offset = 0): Promise<string> {
  const counter = Math.floor(Date.now() / 30_000) + offset;
  return createOTP(secret).hotp(counter);
}

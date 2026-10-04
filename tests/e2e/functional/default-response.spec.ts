/**
 * Functional coverage for the configurable unmatched-host response (issue #241).
 * These tests update Ingressi through its API and then make real requests to Caddy.
 */
import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";
import { resolve } from "node:path";
import { httpGet, waitForBody, type HttpResponse } from "../../helpers/http";

const API = "http://localhost:3000/api/v1";
const ORIGIN = "http://localhost:3000";
const KNOWN_DOMAIN = "func-default-known.test";
const UNKNOWN_DOMAIN = "func-default-unknown.test";
const RESPONSE_MARKER = "CPM_DEFAULT_RESPONSE_241";

type DefaultResponseSettings = {
  mode: "caddy" | "respond" | "redirect" | "abort";
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  redirectUrl?: string;
};

async function setDefaultResponse(request: APIRequestContext, settings: DefaultResponseSettings) {
  const response = await request.put(`${API}/settings/default-response`, {
    data: settings,
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
  });
  expect(response.status()).toBe(200);
}

async function waitForResponse(status: number, body?: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  let lastBody = "";
  while (Date.now() < deadline) {
    try {
      const response = await httpGet(UNKNOWN_DOMAIN);
      lastStatus = response.status;
      lastBody = response.body;
      if (response.status === status && (body === undefined || response.body === body)) return;
    } catch {
      // Caddy may be between config generations.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Default response did not become ${status} (last: ${lastStatus}, ${JSON.stringify(lastBody)})`);
}

async function waitForAbort(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await httpGet(UNKNOWN_DOMAIN);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Default response did not begin aborting connections");
}

test.describe.serial("Default response — live Caddy", () => {
  let hostId: number | null = null;
  let originalSettings: DefaultResponseSettings = { mode: "caddy" };
  let nativeResponse: HttpResponse | null = null;

  test.beforeAll(async () => {
    const request = await playwrightRequest.newContext({
      storageState: resolve(__dirname, "../../.auth/admin.json"),
    });
    const current = await request.get(`${API}/settings/default-response`, {
      headers: { Origin: ORIGIN },
    });
    expect(current.status()).toBe(200);
    const currentBody = await current.json() as Partial<DefaultResponseSettings>;
    if (currentBody.mode) originalSettings = currentBody as DefaultResponseSettings;
    await setDefaultResponse(request, { mode: "caddy" });

    const created = await request.post(`${API}/proxy-hosts`, {
      data: {
        name: "Default Response Known Host",
        domains: [KNOWN_DOMAIN],
        upstreams: ["echo-server:8080"],
        sslForced: false,
      },
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
    });
    expect(created.status()).toBe(201);
    hostId = (await created.json()).id as number;
    await waitForBody(KNOWN_DOMAIN, "echo-ok");
    nativeResponse = await httpGet(UNKNOWN_DOMAIN);
    await request.dispose();
  });

  test.afterAll(async () => {
    const request = await playwrightRequest.newContext({
      storageState: resolve(__dirname, "../../.auth/admin.json"),
    });
    await setDefaultResponse(request, originalSettings);
    if (hostId !== null) {
      const deleted = await request.delete(`${API}/proxy-hosts/${hostId}`, {
        headers: { Origin: ORIGIN },
      });
      expect(deleted.status()).toBe(200);
    }
    await request.dispose();
  });

  test("returns the configured status, body, and headers for unknown hosts and direct IP access", async ({ request }) => {
    await setDefaultResponse(request, {
      mode: "respond",
      status: 418,
      body: RESPONSE_MARKER,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Test-Default": "enabled",
      },
    });
    await waitForResponse(418, RESPONSE_MARKER);

    for (const host of [UNKNOWN_DOMAIN, "127.0.0.1"]) {
      const response = await httpGet(host);
      expect(response.status).toBe(418);
      expect(response.body).toBe(RESPONSE_MARKER);
      expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(response.headers["x-test-default"]).toBe("enabled");
    }
  });

  test("does not shadow a configured proxy host", async () => {
    const response = await httpGet(KNOWN_DOMAIN);
    expect(response.status).toBe(200);
    expect(response.body).toContain("echo-ok");
    expect(response.body).not.toContain(RESPONSE_MARKER);
  });

  test("can redirect unmatched hosts", async ({ request }) => {
    await setDefaultResponse(request, {
      mode: "redirect",
      status: 308,
      redirectUrl: "https://landing.example.test{http.request.uri}",
      headers: { "Cache-Control": "no-store" },
    });
    await waitForResponse(308);

    const response = await httpGet(UNKNOWN_DOMAIN, "/missing?q=1");
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe("https://landing.example.test/missing?q=1");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  test("can abort unmatched connections without an HTTP response", async ({ request }) => {
    await setDefaultResponse(request, { mode: "abort" });
    await waitForAbort();

    await expect(httpGet(UNKNOWN_DOMAIN)).rejects.toThrow();
    const knownResponse = await httpGet(KNOWN_DOMAIN);
    expect(knownResponse.status).toBe(200);
    expect(knownResponse.body).toContain("echo-ok");
  });

  test("can disable the override and restore Caddy's native default", async ({ request }) => {
    expect(nativeResponse).not.toBeNull();
    await setDefaultResponse(request, { mode: "caddy" });
    await waitForResponse(nativeResponse!.status, nativeResponse!.body);

    const response = await httpGet(UNKNOWN_DOMAIN);
    expect(response.status).toBe(nativeResponse!.status);
    expect(response.body).toBe(nativeResponse!.body);
    expect(response.headers.location).toBe(nativeResponse!.headers.location);
  });
});

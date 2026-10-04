import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  toCertificateApiResponse,
  toCertificatePickerOption,
} from "@/src/lib/certificate-api";
import { toEnvSlaveInstanceView } from "@/src/lib/instance-sync-view";

const certificate = {
  id: 7,
  name: "Imported",
  type: "imported" as const,
  domainNames: ["example.com"],
  autoRenew: false,
  providerOptions: {
    provider: "cloudflare",
    api_token: "provider-option-secret-sentinel",
  },
  certificatePem: "public certificate",
  privateKeyPem: "private-key-secret-sentinel",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("browser secret boundaries", () => {
  it("uses allowlisted certificate API and picker views", () => {
    const api = JSON.stringify(toCertificateApiResponse({
      ...certificate,
      futureSecret: "future-secret-sentinel",
    } as typeof certificate));
    const picker = JSON.stringify(toCertificatePickerOption({
      ...certificate,
      futureSecret: "future-secret-sentinel",
    } as typeof certificate));

    expect(api).toContain('"provider":"cloudflare"');
    expect(api).not.toContain("provider-option-secret-sentinel");
    expect(api).not.toContain("private-key-secret-sentinel");
    expect(api).not.toContain("future-secret-sentinel");
    expect(picker).toBe('{"id":7,"name":"Imported"}');
  });

  it("redacts DNS settings and certificate records before client-component props", () => {
    const settingsPage = readFileSync(
      join(process.cwd(), "app/(dashboard)/settings/page.tsx"),
      "utf8"
    );
    const proxyHostsPage = readFileSync(
      join(process.cwd(), "app/(dashboard)/proxy-hosts/page.tsx"),
      "utf8"
    );

    expect(settingsPage).toContain("redactDnsProviderSettingsForApi(dnsProvider)");
    expect(settingsPage).not.toMatch(/dnsProvider=\{dnsProvider\}/);
    expect(proxyHostsPage).toContain(".map(toCertificatePickerOption)");
    expect(proxyHostsPage).not.toMatch(/certificates=\{certificates\}/);
  });

  it("allowlists environment slave metadata before client-component props", () => {
    const view = JSON.stringify(toEnvSlaveInstanceView({
      name: "Edge node",
      url: "https://edge.example.com",
      token: "instance-sync-token-secret-sentinel",
      futureSecret: "future-instance-secret-sentinel",
    } as Parameters<typeof toEnvSlaveInstanceView>[0]));

    expect(view).toBe('{"name":"Edge node","url":"https://edge.example.com"}');
    expect(view).not.toContain("instance-sync-token-secret-sentinel");
    expect(view).not.toContain("future-instance-secret-sentinel");

    const settingsPage = readFileSync(
      join(process.cwd(), "app/(dashboard)/settings/page.tsx"),
      "utf8"
    );
    expect(settingsPage).toMatch(
      /getEnvSlaveInstances\(\)\.map\(toEnvSlaveInstanceView\)/
    );
  });
});

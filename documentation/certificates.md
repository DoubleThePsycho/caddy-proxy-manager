# Certificates

The **Certificates** page (Traffic → Certificates) lists every TLS certificate the product serves, in three tabs.

## Certificates

One row per certificate:

- **ACME certificates.** Caddy gets and renews a certificate on its own for every proxy host without a chosen certificate. A host whose names an imported certificate covers is listed under that certificate instead, and a host covered by a wildcard host (`sub.example.com` under `*.example.com`) under the wildcard.
- **Imported certificates**, uploaded as PEM. They are replaced by hand.
- **Managed entries** left from earlier versions. Caddy obtains these certificates on its own as well; the entries can be deleted.

Each row shows the issuer and key, how the certificate is obtained (HTTP-01, or DNS-01 with the DNS provider set under Settings → DNS Providers; a custom ACME directory under Settings → ACME Server is named as the issuer until a certificate has been read), when it expires, where its renewal stands and which proxy hosts and L4 hosts use it. An L4 host uses a certificate when it terminates TLS for a server name (TLS SNI matcher) the certificate covers.

Renewal states:

- **Automatic**: Caddy renews it from the date shown, a third of its lifetime before it expires (30 days for a 90-day certificate).
- **Due now**: inside that window; Caddy is renewing it.
- **Overdue**: past the middle of the window and still not renewed. Check Caddy's log (challenge errors, DNS provider credentials, port 80 reachable from the internet).
- **Manual** and **Replace soon**: imported certificates, the latter with 30 days or less left.
- **Not managed**: the host is disabled, or no enabled host uses the entry; Caddy manages nothing for it.

Deleting an imported certificate or a managed entry moves the proxy hosts that use it to automatic TLS: Caddy obtains a certificate for their names. A certificate that a host with a wildcard name uses cannot be deleted while no default DNS provider is set, since Caddy could not obtain the wildcard on its own; set one, or give the host another certificate first.

Above the table, the expiry timeline shows the next 90 days with the 30-day renewal band. Selecting a marker highlights its row. Search matches domains, names, issuers and the hosts using a certificate; the status filter shows the certificates due for renewal (including expired ones and imported ones to replace) or the healthy ones.

### Where the expiry comes from

Imported certificates are read from their PEM. For the certificates Caddy obtains, the dashboard cannot read Caddy's storage (it lives in the caddy container's volume, or in Redis/Valkey with high availability), and Caddy's admin API has no endpoint that lists them. So it reads the certificate Caddy actually serves: a TLS handshake to Caddy's HTTPS listener over the internal network, with the domain as server name. That is exactly what clients get, whatever the storage.

- The certificate is only read: its chain is not verified (a staging or internal CA is still shown), it must name the domain, and nothing is sent after the handshake. A wildcard domain is read as `tls-check.<domain>`; IP addresses are skipped.
- The same reading serves this page, the certificate alerts ([alerting](../ee/docs/alerting.md#certificates-caddy-manages)), the overview's **Needs attention** list, the setup checklist and compliance checks. At most six handshakes run at a time, each with a five-second timeout, and one per name: callers asking for a name being read share its handshake.
- Results are kept for 30 minutes when the certificate is valid, five minutes otherwise (none found, about to expire, not naming the domain, Caddy not reachable). The page waits at most three seconds for handshakes; a certificate not read yet shows **Not read yet** and appears on the next visit.
- Address: the host of `CADDY_API_URL` on port 443 (in Docker Compose, `caddy:443`). Set `CADDY_TLS_ADDRESS` (`host:port`, for example `caddy:443`, or `[::1]:8443`) on the web container when Caddy's HTTPS listener is somewhere else; `CADDY_TLS_ADDRESS=off` turns the reading off (the page then shows no expiry for these certificates, and certificate alerts about them stay as they are). In a fleet, each node reads its own Caddy.

## Certificate authorities

Certificate authorities for client certificates (mutual TLS): generate one here, which stores its private key encrypted and lets you issue client certificates, or import a CA's certificate so the client certificates it signs elsewhere are trusted. **Trusted by** lists the proxy hosts whose mutual TLS trusts the CA, its client certificates or a role holding them.

## Client certificates

**Roles** group client certificates; mutual TLS on a proxy host can require a role. Each card shows how many active certificates the role holds and which hosts require it; its menu chooses the certificates, renames or deletes the role.

The table lists every client certificate issued here, with its role, issuing CA and expiry. **Revoke** stops proxy hosts accepting it at once and cannot be undone. **Issue client certificate** asks for the common name, validity and an export password, and downloads the certificate with its private key and the CA chain as a `.p12` bundle; the private key is not stored.

Organisation users and roles limited to tags see only the **Certificates** tab: certificate authorities, client certificates and roles serve every host.

## Obtaining and storing certificates

Caddy automatically obtains Let's Encrypt certificates for all proxy hosts.

**DNS-01 Challenge** (optional): Configure a DNS provider in **Settings → Certificates and ACME** (DNS-01 providers) for wildcard certificates and environments where ports 80/443 are not public. Supported providers: Cloudflare, Route 53, DigitalOcean, Duck DNS, Hetzner, Vultr, Porkbun, GoDaddy, Namecheap, OVH, IONOS, Linode, Njalla, netcup, Spaceship, deSEC, Dynu, acme-dns, Infomaniak, INWX, ClouDNS, and RFC2136 (BIND/TSIG). Credentials are encrypted at rest with AES-256-GCM. You can override the DNS provider per certificate. The DNS propagation delay and timeout can be set per provider (netcup ships with slow-propagation defaults).

**Custom Certificates** (optional): Import your own certificates via the Certificates page. Private keys are encrypted at rest with AES-256-GCM, migrated from legacy plaintext storage on startup, and treated as write-only by ordinary API responses and browser payloads.

**Built-in CA** (mTLS): CA private keys are encrypted at rest the same way and never leave the master (see [Instance sync](instance-sync.md)). Back them up with the database and `SESSION_SECRET`.

## REST API

`GET /api/v1/certificates/overview` (permission `certificates:read`) returns the rows of the first tab:

```bash
curl https://dash.example.com/api/v1/certificates/overview -H "Authorization: Bearer $TOKEN"
```

```json
{
  "generatedAt": "2026-10-03T12:00:00.000Z",
  "certificates": [
    {
      "id": "acme:12",
      "kind": "acme",
      "domains": ["app.example.com"],
      "issuer": "Let's Encrypt",
      "validTo": "2026-11-03T08:14:00.000Z",
      "daysLeft": 30,
      "expirySource": "caddy",
      "obtainedBy": { "method": "acme", "challenge": "http-01", "dnsProvider": null, "directory": null },
      "renewal": { "state": "due", "renewFrom": "2026-10-04T08:14:00.000Z" },
      "usedBy": [{ "kind": "proxy_host", "id": 12, "name": "App", "domains": ["app.example.com"] }]
    }
  ]
}
```

It follows the same rules as the page: a role limited to tags sees the certificates of its in-scope proxy hosts, organisation users their organisation's (provider-level callers can pass `organizationId`), and L4 hosts appear in `usedBy` only with `l4_proxy_hosts:read`. No PEM or key material is returned; the full certificate list stays at `GET /api/v1/certificates`.

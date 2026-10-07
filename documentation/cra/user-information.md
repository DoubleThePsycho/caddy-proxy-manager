# Information and instructions for users

The information that Regulation (EU) 2024/2847 (Cyber Resilience Act), Annex II, asks a manufacturer to give with its product. Ingressi's full CRA obligations apply from 11 December 2027; the reporting obligations of Article 14 apply already.

## 1. Manufacturer

FUO.FI Cybersecurity di Nicolò Campari
Via Giovanni Segantini 63, 40133 Bologna (BO), Italy
VAT number IT04388461206 · REA BO-589619
E-mail: support@ingres.si · Website: https://ingres.si

## 2. Reporting a vulnerability

- Privately through GitHub: https://github.com/ingres-si/ingressi/security/advisories/new
- By e-mail: security@ingres.si (English or Italian)

The coordinated vulnerability disclosure policy is in [SECURITY.md](../../SECURITY.md#disclosure-policy); the same contacts are in https://ingres.si/.well-known/security.txt.

## 3. Product identification

Ingressi, a self-hosted reverse proxy built on Caddy. It is distributed as three container images, identified by their release tag (for example `2.0.1`) and digest:

- `ghcr.io/ingres-si/ingressi-web` (the dashboard and REST API that configure the reverse proxy, and background jobs)
- `ghcr.io/ingres-si/ingressi-caddy` (the reverse proxy engine: Caddy with Ingressi's modules for L4 proxying, the WAF, rate limiting and geo blocking, each off until configured)
- `ghcr.io/ingres-si/ingressi-l4-port-manager` (publishes L4 ports)

The dashboard shows the version in the account menu. Each release is on https://github.com/ingres-si/ingressi/releases.

## 4. Intended purpose, security environment and security properties

**Intended purpose:** Ingressi is a self-hosted reverse proxy built on Caddy, run on a Linux server with Docker. It receives HTTP(S), TCP and UDP traffic for the domains and ports an administrator configures, terminates TLS with certificates it obtains automatically, and forwards the traffic to upstream services, with load balancing and health checks. A web dashboard and a REST API configure it, and it records traffic analytics and an audit log. Optional features are off until an administrator turns them on, for one host or for all hosts:

- a web application firewall (Coraza with the OWASP Core Rule Set);
- access lists, geo blocking and rate limiting;
- a sign-in portal in front of proxied apps. It signs people in with their Ingressi account (a password or OAuth). Single sign-on across apps comes from the operator's identity provider (OIDC, SAML or LDAP): the portal reuses a dashboard session only when that provider created it. Ingressi is not an identity provider for other applications. It passes the user's identity to the app in `X-Ingressi-*` headers, and takes its access rules from Ingressi's users and groups, which SCIM provisioning and access reviews can manage;
- client certificates (mutual TLS) from a built-in CA;
- instance sync, which copies the configuration to other Ingressi installs.

**Security environment the product expects:**

- a Linux host that you keep updated, with Docker and Docker Compose;
- the host and its disks protected by you (the databases are not encrypted by Ingressi; stored secrets are);
- the dashboard reachable only over HTTPS or from a trusted network (see 8(a));
- outbound HTTPS to the certificate authorities and DNS providers you configure and, for license keys from ingres.si, to `license.ingres.si`.

**Security properties:**

- production installs refuse to start with the default or an example admin password, or with a short or known `SESSION_SECRET`;
- stored secrets (DNS credentials, OAuth client secrets, certificate and CA private keys, sync tokens) are encrypted with a key derived from `SESSION_SECRET`;
- sign-in paths are rate limited; multi-factor authentication (authenticator app or passkey) is available to every account and can be required;
- every configuration change is written to an audit log linked into a hash chain;
- release images are signed with Sigstore cosign and carry an SBOM and a build provenance attestation;
- a license never affects traffic: proxying, TLS, the WAF and sign-in keep working with an expired, missing or revoked license.

## 5. Circumstances that can lead to significant cybersecurity risks

- **Dashboard over plain HTTP.** The example `docker-compose.yml` publishes the dashboard on port 3000 without TLS. Anyone on the network path can read passwords and session cookies. See 8(a).
- **Not updating.** Fixes ship only in new releases. Running an old release leaves known vulnerabilities open.
- **WAF left in "Detection only"** on a host where you turned it on: attacks are logged, not blocked.
- **Upstreams over plain HTTP or with TLS verification turned off** expose the traffic between Ingressi and your application.
- **Leaked `SESSION_SECRET` or `.env`.** It decrypts the stored secrets and can forge sessions.
- **Exposed L4 ports and the Docker socket.** L4 hosts publish ports directly; the L4 port manager reaches Docker only through the socket proxy of the compose file — do not mount `/var/run/docker.sock` into other services.
- **Shared admin accounts and API tokens without expiry** make misuse hard to trace and to stop.

## 6. EU declaration of conformity

Not issued yet. It will be published at https://ingres.si/security/ once the conformity assessment is complete, before conforming releases are placed on the market from 11 December 2027.

## 7. Security support and support period

- Security updates are provided until at least **December 2032**.
- Fixes are released on the latest version, free of charge for every edition; upgrading is free. Announced long-term-support lines also receive them until their stated end.
- Fixed vulnerabilities are published as GitHub Security Advisories, with a CVE where it applies: https://github.com/ingres-si/ingressi/security/advisories.
- Older releases remain downloadable for reference; they receive no fixes, and running them is a security risk.

## 8. Instructions

### (a) Secure commissioning and use

1. Create `.env` from `.env.example` with a generated `SESSION_SECRET` (`openssl rand -base64 32`) and your own `ADMIN_PASSWORD`; keep the file readable only by root (`chmod 600 .env`).
2. Do not publish the dashboard port to untrusted networks: change `"3000:3000"` to `"127.0.0.1:3000:3000"` and reach the dashboard through a proxy host with HTTPS, a VPN or an SSH tunnel.
3. Turn on multi-factor authentication for every administrator, and set the MFA policy on the Users page to require it.
4. Give each person their own account and the smallest role they need; give API tokens only the permissions they use.
5. If you turn on the WAF for a host, set it to blocking once its events look right. Keep the Needs attention list empty.
6. Back up the data volumes and `.env` regularly, encrypted, and test a restore.
7. Verify image signatures before running new releases (see [SECURITY.md](../../SECURITY.md#verifying-release-images)).

### (b) How changes affect the security of data

- Rotating `SESSION_SECRET` needs `SESSION_SECRET_PREVIOUS` for one start, or stored secrets can no longer be decrypted ([security.md](../security.md#rotating-session_secret)).
- Turning off the WAF, an access list or sign-in on a host exposes that application directly.
- Allowing HTTP for instance sync (`INSTANCE_SYNC_ALLOW_HTTP=true`) exposes the sync token on the network path.
- Enabling analytics (ClickHouse) stores visitors' IP addresses, paths and user agents for its retention period.
- Exported configurations contain secrets; they are encrypted with the passphrase you choose.

### (c) Installing security updates

```sh
docker compose pull && docker compose up -d
```

Back up the data volumes first. Release notes say when a release contains a security fix. To be told about new releases, watch the repository's releases on GitHub (Watch → Custom → Releases) or subscribe to its security advisories.

### (d) Secure decommissioning and removal of data

1. Export the configuration if you will need it: **Export configuration** on the Change history page, or the `/api/v1/config/export` endpoint; the file is encrypted with a passphrase you choose.
2. Stop the stack and delete its volumes: `docker compose down -v` (removes the database, certificates and keys, Caddy data, logs, analytics and GeoIP data).
3. Delete `.env`, any backups and exported files you no longer need; if the host's disks are reused, wipe them.
4. Revoke what Ingressi used elsewhere: DNS provider API keys, OAuth client secrets, API tokens of other systems.
5. With a license key from ingres.si, select **Deactivate on this install** on the License page first, so the license can move to another install.

To reset Ingressi to its original state, do steps 2 and 3 and start again from a fresh `.env`.

### (e) Automatic security updates

Ingressi does not install updates by itself; nothing needs to be turned off. If you run a container updater (for example Watchtower) to update the images automatically, remove it from the compose file, or exclude the Ingressi containers, to stop automatic updates.

### (f) Integration into other products

Ingressi is not intended for integration into other products. Its REST API is documented at `/api-docs` on every install.

## 9. Software bill of materials

- A CycloneDX SBOM of the source tree is attached to each GitHub release from v2.0.1.
- Each image carries an SBOM attestation: `docker buildx imagetools inspect ghcr.io/ingres-si/ingressi-web:<tag> --format '{{ json .SBOM }}'`.

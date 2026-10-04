# Air-gapped installs

Feature id `air_gap`, Enterprise edition: an offline install bundle for hosts that cannot reach GitHub's container registry or the Internet, and long-term-support releases.

Licensing already works offline: a license key is verified against the public key built into the release and never phones home.

## Building a bundle

On a machine with Docker, Internet access and [cosign](https://docs.sigstore.dev/cosign/system_config/installation/), check out the release tag and run:

```bash
ee/scripts/airgap-bundle.sh --version 2.0.0 --platform linux/amd64
```

The script:

1. Pulls the images the default stack runs, for the target platform: `ingressi-web`, `ingressi-caddy` and `ingressi-l4-port-manager` at the release tag, and the ClickHouse and Docker socket proxy images exactly as `docker-compose.yml` names them. `geoipupdate` is left out because it needs Internet access.
2. Verifies the cosign signature of each Ingressi image against the release workflow. It stops if one is missing or invalid.
3. Writes `dist/ingressi-airgap-<version>-<platform>.tar` with its SHA-256 next to it.

| Option | Default | Meaning |
| --- | --- | --- |
| `--version` | (required) | Release tag of the Ingressi images |
| `--platform` | `linux/amd64` | Platform of the target host (`linux/arm64` for ARM servers) |
| `--output` | `./dist` | Where to write the bundle |
| `--image-prefix` | `ghcr.io/ingres-si/ingressi` | Registry and name prefix of the Ingressi images, for a mirror |
| `--no-pull` | off | Use images already present locally |
| `--skip-verify` | off | Do not check signatures (for images you built yourself) |

The bundle contains:

- `images.tar.gz`: every image;
- `docker-compose.yml`, pinned to the release's Ingressi images, and the ClickHouse config file it mounts;
- `.env.example`;
- `install.sh`;
- `manifest.json`: version, platform, whether signatures were verified, and each image's registry digest;
- `SHA256SUMS` over all of the above.

## Installing

Copy the `.tar` and its `.sha256` file to the target host by your approved transfer process, then:

```bash
sha256sum -c ingressi-airgap-2.0.0-linux-amd64.tar.sha256
tar -xf ingressi-airgap-2.0.0-linux-amd64.tar
cd ingressi-airgap-2.0.0-linux-amd64
./install.sh
```

`install.sh` checks `SHA256SUMS`, loads the images and creates `.env` from `.env.example` (mode 600) if there is none. Fill in `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `CLICKHOUSE_PASSWORD`, set `COMPOSE_PROFILES=clickhouse` for analytics, and start the stack:

```bash
docker compose up -d
```

To upgrade, build a bundle of the new release, run its `install.sh` in its own directory, copy your `.env` over, and run `docker compose up -d` there. The data lives in Docker volumes, so it carries over. The compose project name comes from the directory name: pass the old one with `-p` (for example `docker compose -p ingressi-airgap-2-0-0-linux-amd64 up -d`), or keep using one fixed directory and copy the new bundle's files into it.

## Running without Internet access

| Function | Offline approach |
| --- | --- |
| Certificates | Automatic Let's Encrypt or ZeroSSL issuance needs Internet access. Use your internal ACME CA (**Settings → Certificates and ACME → Custom ACME directory**, with its root certificate), import certificates, or issue them from the built-in CA. |
| GeoIP blocking | Copy `GeoLite2-Country.mmdb` and `GeoLite2-ASN.mmdb` into the `geoip-data` volume (for example `docker run --rm -v <project>_geoip-data:/data -v "$PWD":/src alpine cp /src/GeoLite2-Country.mmdb /src/GeoLite2-ASN.mmdb /data/`) and refresh them with each bundle. |
| AI analyst | Point it at a model server on your network (any OpenAI-compatible endpoint such as vLLM or Ollama). |
| Alerts and digests | Use your internal SMTP relay and webhook endpoints. |
| License | Works offline. Install renewed keys on the **License** page as usual. Automatic updates stay off, and the bundle's `.env.example` sets `LICENSE_AUTO_UPDATE_DISABLED=true` so they cannot be turned on. |
| Virtual patches | Download the signed rule feed on a connected machine and import it under **WAF settings → Virtual patches → Import feed file**, at least as often as feeds expire (30 days). It is verified offline like a fetched one ([virtual-patching.md](virtual-patching.md)). |
| Usage ping | Off unless an administrator says yes, and the bundle's `.env.example` sets `USAGE_PING_DISABLED=true`: nothing is sent and the question is hidden. Keep the variable when you carry an older `.env` over ([documentation/usage-ping.md](../../documentation/usage-ping.md)). |

## Long-term-support releases

Enterprise customers can stay on an LTS release line for 24 months: security and critical fixes, backported, without new features or breaking changes. Policy, branches and image tags are in [lts.md](lts.md). Build the bundle from the LTS tag like any release.

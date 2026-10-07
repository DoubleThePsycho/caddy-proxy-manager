# Security Policy

## Supported versions and support period

Ingressi receives security updates until at least **December 2032**.

| Version | Security fixes |
| ------- | -------------- |
| Latest release | :white_check_mark: |
| Long-term-support lines, within their 24 months once announced ([ee/docs/lts.md](ee/docs/lts.md); none yet) | :white_check_mark: |
| Earlier releases | :x: |

- Fixes ship as a new release of the latest version. A release that fixes a vulnerability contains only that fix and what it needs, where possible.
- Security updates are free for every edition, and so is upgrading: `docker compose pull && docker compose up -d`. No security fix needs a license.
- Earlier releases stay on GitHub and in the registry for reference, and every image that carried a security fix stays available for at least 10 years. They receive no fixes: running them is a security risk.

## Reporting a vulnerability

Do not open a public issue. Report it:

- through GitHub's private vulnerability reporting: <https://github.com/ingres-si/ingressi/security/advisories/new>; or
- by e-mail to security@ingres.si.

English or Italian. Include the type of vulnerability, the affected version, steps to reproduce, the impact you see and a fix if you have one.

We answer within 48 hours, confirm or dismiss the issue within 5 working days, and keep you updated until it is fixed. The same contacts are in <https://ingres.si/.well-known/security.txt> (RFC 9116).

### Disclosure policy

- We follow coordinated disclosure. Keep the details private until a fix is released or 90 days have passed since your report, whichever comes first; if a fix needs more time, we agree it with you.
- We fix the issue on the latest release and publish a GitHub Security Advisory, with a CVE when the issue warrants one: <https://github.com/ingres-si/ingressi/security/advisories>. Advisories also reach the GitHub Advisory Database and OSV in machine-readable form.
- Reporters are credited in the advisory unless they prefer not to be.
- Actively exploited vulnerabilities and severe incidents affecting the security of Ingressi are reported to CSIRT Italia and ENISA through the EU Single Reporting Platform, as Article 14 of the Cyber Resilience Act (Regulation (EU) 2024/2847) requires, and users are told what to do through the advisory, the release notes and, for license holders, by e-mail.
- Testing must stay within installations you own or are authorised to test. Do not access other people's data or degrade services.

## Information for users

Manufacturer details, intended use, known risks, secure setup, updates and data removal: [documentation/cra/user-information.md](documentation/cra/user-information.md).

## Verifying release images

Every image pushed by the release workflow is signed with [Sigstore cosign](https://docs.sigstore.dev/) keyless signing, tied to this repository's GitHub Actions workflow, and carries an SBOM and a build provenance attestation. To verify an image before running it, with cosign 3 or later:

```bash
cosign verify ghcr.io/ingres-si/ingressi-web:latest \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/ingres-si/ingressi/\.github/workflows/docker-build-trusted\.yml@refs/(heads|tags)/'
```

The same works for `ingressi-caddy` and `ingressi-l4-port-manager`.

## Software bill of materials

- Each GitHub release from v2.0.1 has a CycloneDX SBOM of the source tree attached.
- Each image carries an SBOM attestation: `docker buildx imagetools inspect ghcr.io/ingres-si/ingressi-web:<tag> --format '{{ json .SBOM }}'`.

## Security measures

### Build pipeline

1. **Fork pull requests** need a maintainer's `safe-to-build` label before builds run.
2. **No push from pull requests:** they only build images locally.
3. **SBOM and provenance** are generated for every image build.
4. **Signed images:** release images are signed with cosign keyless signing (see [Verifying release images](#verifying-release-images)).
5. **Limited permissions:** workflows use the permissions they need and no more.

### Containers

- Images are built for `linux/amd64` and `linux/arm64`.
- The web and Caddy containers run as non-root users.
- The Docker socket is reached only through a socket proxy that filters API calls.

### Dependencies

- Dependabot opens dependency updates, and its security alerts and security updates are on.
- Only patch and minor updates of the application's JavaScript (Bun) packages, in pull requests opened by Dependabot itself, merge automatically; major versions, GitHub Actions, Go modules (the Caddy build and its plugins) and container images wait for a maintainer's review.
- Secret scanning with push protection is on.
- CodeQL code scanning is on.

## Security practices for contributors

1. Never commit secrets, tokens or credentials.
2. Use environment variables for sensitive configuration.
3. Keep dependencies up to date.
4. Follow the principle of least privilege.
5. Validate and sanitise all user input.
6. Use parameterised queries for database operations.

## Safe-to-build label

For maintainers reviewing fork pull requests:

1. Review the code for malicious content.
2. Check for suspicious file changes.
3. Check that no secrets or credentials are exposed.
4. Add `safe-to-build` only once the code is verified.
5. Remove the label at once if a concern arises.

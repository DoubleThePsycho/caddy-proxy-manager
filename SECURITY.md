# Security Policy

## Supported Versions

We release patches for security vulnerabilities for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| LTS lines within their 24 months ([ee/docs/lts.md](ee/docs/lts.md)) | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it by:

1. **DO NOT** open a public issue
2. Use GitHub's private vulnerability reporting: <https://github.com/ingres-si/caddy-proxy-manager/security/advisories/new>
3. Include detailed information about the vulnerability:
   - Type of vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will respond within 48 hours and provide regular updates on the fix progress.

The same contact is published in machine-readable form at <https://ingres.si/.well-known/security.txt> (RFC 9116).

### Disclosure policy

- We follow coordinated disclosure. Please keep the details private until a fix is released or 90 days have passed since your report, whichever comes first; we may ask for more time when a fix needs it, and agree it with you.
- We confirm the issue, agree its severity with you, fix it on the latest release and publish a GitHub Security Advisory with a CVE when the issue warrants one.
- Reporters are credited in the advisory unless they prefer not to be.
- An actively exploited vulnerability is also reported as the EU Cyber Resilience Act requires of manufacturers.
- Testing must stay within installations you own or are authorised to test. Do not access other people's data or degrade services.

## Verifying Release Images

Every image pushed by the release workflow is signed with [Sigstore cosign](https://docs.sigstore.dev/) keyless signing, tied to this repository's GitHub Actions workflow, and carries an SBOM and build provenance attestation. To verify an image before running it:

```bash
cosign verify ghcr.io/ingres-si/ingressi-web:latest \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/ingres-si/(caddy-proxy-manager|ingressi)/\.github/workflows/docker-build-trusted\.yml@refs/(heads|tags)/'
```

The same works for `ingressi-caddy` and `ingressi-l4-port-manager`, and for the images under their former `caddy-proxy-manager-*` names. Each GitHub release also has a CycloneDX SBOM of the source tree attached.

## Security Measures

### Build Pipeline Security

Our CI/CD pipeline implements multiple security layers:

1. **Fork PR Protection**: Pull requests from forks require manual approval (via `safe-to-build` label) before builds run
2. **SBOM Generation**: Software Bill of Materials is generated for all builds, and a CycloneDX SBOM is attached to every release
3. **Provenance Attestation**: Build provenance is recorded for supply chain security
4. **Signed Images**: Release images are signed with cosign keyless signing (see [Verifying Release Images](#verifying-release-images))
5. **Limited Permissions**: Workflows use minimal required permissions
6. **No Push from PRs**: Pull requests only build images locally, never push to registry

### Container Security

- Verified amd64 image builds
- Regular base image updates
- Minimal attack surface
- Non-root user execution where possible

### Dependency Management

- Automated dependency updates via Dependabot
- Only patch and minor updates of the application's JavaScript (Bun) packages, in PRs opened by Dependabot itself, are approved and merged automatically; major versions, GitHub Actions, Go modules (the Caddy build and its plugins) and container images wait for a maintainer's review
- Security alerts enabled
- Regular security audits

## Security Best Practices for Contributors

When contributing:

1. Never commit secrets, tokens, or credentials
2. Use environment variables for sensitive configuration
3. Keep dependencies up to date
4. Follow principle of least privilege
5. Validate and sanitize all user inputs
6. Use parameterized queries for database operations

## Automated Security Checks

Our repository includes:

- **Dependabot** for dependency updates
- **GitHub Security Advisories** monitoring

## Safe-to-Build Label

For maintainers reviewing fork PRs:

1. Review the PR code thoroughly for malicious content
2. Check for suspicious file modifications
3. Verify no secrets or credentials are exposed
4. Only add `safe-to-build` label if code is verified safe
5. Remove label immediately if concerns arise

## Security Updates

Security updates are prioritized and released as soon as possible. Subscribe to repository releases to stay informed.

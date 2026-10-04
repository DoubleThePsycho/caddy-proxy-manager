# Long-term-support releases

Part of feature id `air_gap`, Enterprise edition: release lines that get security and critical fixes for 24 months without new features, for organisations that change production on a slow, audited schedule.

> The cadence and scope below are the proposed defaults. Confirm them before the first LTS line is announced.

## Policy

- **Which releases:** one minor release a year is designated LTS in its release notes (for example 2.0). Its line is supported for 24 months from that release, so two LTS lines overlap for a year.
- **What gets backported:**
  - fixes for security vulnerabilities;
  - fixes for data loss, outages and security regressions;
  - updates of Caddy, Go, Bun and base images that fix a vulnerability.
- **What does not:** new features, behaviour changes, and database migrations, unless a fix cannot be made without one.
- **Upgrades:** each LTS line is tested to upgrade directly from the previous LTS line.

## How it works

- **Branches:** an LTS line lives on `lts/<major>.<minor>`, branched from its `v<major>.<minor>.0` tag. Patch releases are tags on that branch (`v2.0.7`).
- **Images:** the release workflow builds the branch like any release.
  - `:2.0.7` and `:2.0` follow the line, so pin `:2.0` to stay on it.
  - An LTS patch release never moves `latest`, or the major tag, back to an older version: those go only to the newest stable release.
- **Backports:** label a merged pull request `backport lts/2.0`. The backport workflow (`.github/workflows/backport.yml`) opens a cherry-pick pull request against that branch, and reports conflicts on the original pull request.
- **Dependency updates:** Dependabot opens pull requests against `develop` only. Maintainers backport the security updates by label, like any other fix.
- **Air-gapped installs:** build the bundle from the LTS tag, as for any release ([air-gapped.md](air-gapped.md)).

## What the license covers

LTS releases are published like every release: the free features are free on them, and paid features need a license, as always. An Enterprise subscription covers the commitment: the backport scope above for the life of the line, and support for running it.

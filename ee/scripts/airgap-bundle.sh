#!/usr/bin/env bash
# SPDX-License-Identifier: Elastic-2.0
#
# Builds an offline install bundle of an Ingressi release for hosts without
# Internet access (feature `air_gap`, see ee/docs/air-gapped.md).
#
# Run it from a checkout of the release on a machine with Docker and Internet
# access. The bundle holds every image the default stack runs (pinned to the
# release), the compose file and its mounted config, .env.example, an install
# script, a manifest of the images' registry digests and SHA-256 checksums.
#
# Usage:
#   ee/scripts/airgap-bundle.sh --version 2.0.0 [--platform linux/amd64]
#                               [--output DIR] [--image-prefix PREFIX]
#                               [--no-pull] [--skip-verify]
#
#   --version       Release tag of the Ingressi images (required).
#   --platform      Platform of the target host (default linux/amd64).
#   --output        Directory to write the bundle to (default ./dist).
#   --image-prefix  Prefix of the Ingressi images (default ghcr.io/ingres-si/ingressi).
#   --no-pull       Use images already present locally instead of pulling.
#   --skip-verify   Do not check the Ingressi images' cosign signatures.

set -euo pipefail

VERSION=""
PLATFORM="linux/amd64"
OUTPUT="./dist"
IMAGE_PREFIX="ghcr.io/ingres-si/ingressi"
PULL=1
VERIFY=1
SIGNER_IDENTITY='^https://github\.com/ingres-si/(caddy-proxy-manager|ingressi)/\.github/workflows/docker-build-trusted\.yml@refs/tags/'
SIGNER_ISSUER="https://token.actions.githubusercontent.com"

die() { echo "airgap-bundle: $*" >&2; exit 1; }
log() { echo "airgap-bundle: $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --image-prefix) IMAGE_PREFIX="${2:-}"; shift 2 ;;
    --no-pull) PULL=0; shift ;;
    --skip-verify) VERIFY=0; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

[ -n "$VERSION" ] || die "--version is required"
case "$VERSION" in *[!A-Za-z0-9._-]*) die "--version may only contain letters, digits, '.', '_' and '-'" ;; esac
command -v docker >/dev/null || die "docker is not installed"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$REPO_ROOT/docker-compose.yml" ] || die "run this from an Ingressi checkout"

if command -v sha256sum >/dev/null; then
  SHA256="sha256sum"
elif command -v shasum >/dev/null; then
  SHA256="shasum -a 256"
else
  die "sha256sum or shasum is required"
fi

# The images of the default stack: Ingressi's own at the release tag, and the
# third-party ones exactly as docker-compose.yml names them. geoipupdate is
# left out: it needs Internet access to do anything.
INGRESSI_IMAGES=(
  "$IMAGE_PREFIX-web:$VERSION"
  "$IMAGE_PREFIX-caddy:$VERSION"
  "$IMAGE_PREFIX-l4-port-manager:$VERSION"
)
THIRD_PARTY_IMAGES=()
while IFS= read -r image; do
  case "$image" in
    */ingressi-*|*/caddy-proxy-manager-*|*geoipupdate*|"") ;;
    *) THIRD_PARTY_IMAGES+=("$image") ;;
  esac
done < <(sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$REPO_ROOT/docker-compose.yml")
ALL_IMAGES=("${INGRESSI_IMAGES[@]}" "${THIRD_PARTY_IMAGES[@]}")

PLATFORM_SLUG="${PLATFORM//\//-}"
NAME="ingressi-airgap-$VERSION-$PLATFORM_SLUG"
BUNDLE="$OUTPUT/$NAME"
[ -e "$BUNDLE" ] && die "$BUNDLE already exists"
mkdir -p "$BUNDLE/docker/clickhouse/config.d"

if [ "$PULL" = 1 ]; then
  for image in "${ALL_IMAGES[@]}"; do
    log "pulling $image ($PLATFORM)"
    docker pull --quiet --platform "$PLATFORM" "$image" >/dev/null
  done
fi

SIGNATURES="not verified"
if [ "$VERIFY" = 1 ]; then
  command -v cosign >/dev/null || die "cosign is not installed: install it, or pass --skip-verify"
  for image in "${INGRESSI_IMAGES[@]}"; do
    log "verifying the signature of $image"
    cosign verify --certificate-oidc-issuer "$SIGNER_ISSUER" \
      --certificate-identity-regexp "$SIGNER_IDENTITY" "$image" >/dev/null 2>&1 \
      || die "$image has no valid signature from the release workflow"
  done
  SIGNATURES="verified with cosign against the release workflow"
fi

for image in "${ALL_IMAGES[@]}"; do
  docker image inspect "$image" >/dev/null 2>&1 || die "$image is not available locally"
  arch="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
  [ "$arch" = "$PLATFORM" ] || die "$image is $arch, not $PLATFORM (pull it with --platform $PLATFORM)"
done

log "saving ${#ALL_IMAGES[@]} images"
if ! docker save --platform "$PLATFORM" "${ALL_IMAGES[@]}" 2>/dev/null | gzip -6 > "$BUNDLE/images.tar.gz"; then
  # Docker before 28 has no --platform on save; the images are single-platform here.
  docker save "${ALL_IMAGES[@]}" | gzip -6 > "$BUNDLE/images.tar.gz"
fi

# The compose file pinned to the release: the Ingressi images at its tag.
sed -E "s#^([[:space:]]*image:[[:space:]]*)[^[:space:]]*/(ingressi|caddy-proxy-manager)-(web|caddy|l4-port-manager):[^[:space:]]+#\1$IMAGE_PREFIX-\3:$VERSION#" \
  "$REPO_ROOT/docker-compose.yml" > "$BUNDLE/docker-compose.yml"
cp "$REPO_ROOT/docker/clickhouse/config.d/low-disk-write.xml" "$BUNDLE/docker/clickhouse/config.d/"
cp "$REPO_ROOT/.env.example" "$BUNDLE/.env.example"

{
  echo "{"
  echo "  \"product\": \"Ingressi\","
  echo "  \"version\": \"$VERSION\","
  echo "  \"platform\": \"$PLATFORM\","
  echo "  \"created\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\","
  echo "  \"signatures\": \"$SIGNATURES\","
  echo "  \"images\": ["
  last=$((${#ALL_IMAGES[@]} - 1))
  for i in "${!ALL_IMAGES[@]}"; do
    image="${ALL_IMAGES[$i]}"
    # The registry digest ties the image to its cosign signature; an image
    # that never came from a registry has none.
    digest="$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$image")"
    sep=","; [ "$i" = "$last" ] && sep=""
    echo "    { \"ref\": \"$image\", \"registryDigest\": \"${digest#*@}\" }$sep"
  done
  echo "  ]"
  echo "}"
} > "$BUNDLE/manifest.json"

# The image references, checked by install.sh after loading.
printf '%s\n' "${ALL_IMAGES[@]}" > "$BUNDLE/images.txt"

cat > "$BUNDLE/install.sh" <<'INSTALL'
#!/bin/sh
# Loads the bundled images and prepares the stack. Run it in this directory on
# the target host, then fill in .env and start with: docker compose up -d
set -eu
cd "$(dirname "$0")"

if command -v sha256sum >/dev/null; then
  sha256sum -c SHA256SUMS
else
  shasum -a 256 -c SHA256SUMS
fi

echo "Loading images..."
gunzip -c images.tar.gz | docker load

# SHA256SUMS covers the image archive; check that every image is now present.
while read -r ref; do
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    echo "install: $ref is missing after loading the images" >&2
    exit 1
  fi
done < images.txt

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created .env: set SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD and CLICKHOUSE_PASSWORD,"
  echo "then start the stack with: docker compose up -d"
else
  echo "Images loaded. Start or update the stack with: docker compose up -d"
fi
INSTALL
chmod +x "$BUNDLE/install.sh"

(cd "$BUNDLE" && $SHA256 images.tar.gz images.txt manifest.json docker-compose.yml \
  docker/clickhouse/config.d/low-disk-write.xml .env.example install.sh > SHA256SUMS)

tar -C "$OUTPUT" -cf "$OUTPUT/$NAME.tar" "$NAME"
(cd "$OUTPUT" && $SHA256 "$NAME.tar" > "$NAME.tar.sha256")
log "bundle written to $OUTPUT/$NAME.tar ($(du -h "$OUTPUT/$NAME.tar" | cut -f1)), checksum in $NAME.tar.sha256"

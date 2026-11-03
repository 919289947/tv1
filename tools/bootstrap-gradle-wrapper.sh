#!/usr/bin/env bash
# Fetch the official Gradle 8.9 Wrapper JAR and verify its published SHA-256.
# The JAR is downloaded rather than bundled because the preparation container
# has no outbound network access. GitHub Actions runs this before setup-gradle.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER_DIR="$ROOT/android/gradle/wrapper"
JAR="$WRAPPER_DIR/gradle-wrapper.jar"
EXPECTED_FILE="$WRAPPER_DIR/gradle-wrapper.jar.sha256"
URL="https://services.gradle.org/distributions/gradle-8.9-wrapper.jar"

if [[ ! -f "$EXPECTED_FILE" ]]; then
  echo "ERROR: missing pinned Wrapper checksum: $EXPECTED_FILE" >&2
  exit 31
fi
EXPECTED="$(tr -d '[:space:]' < "$EXPECTED_FILE")"
if [[ ! "$EXPECTED" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ERROR: malformed Gradle Wrapper checksum." >&2
  exit 32
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "ERROR: sha256sum or shasum is required." >&2
    return 1
  fi
}
verify_jar() {
  local actual
  actual="$(sha256_of "$1")"
  if [[ "$actual" != "$EXPECTED" ]]; then
    echo "ERROR: Gradle Wrapper JAR SHA-256 mismatch." >&2
    echo "Expected: $EXPECTED" >&2
    echo "Actual:   $actual" >&2
    return 1
  fi
}

if [[ -f "$JAR" ]]; then
  verify_jar "$JAR" && exit 0
  rm -f "$JAR"
fi

mkdir -p "$WRAPPER_DIR"
TMP="$JAR.download"
trap 'rm -f "$TMP"' EXIT
if command -v curl >/dev/null 2>&1; then
  curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 20 "$URL" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget --tries=3 --timeout=20 -O "$TMP" "$URL"
else
  echo "ERROR: curl or wget is required to bootstrap Gradle Wrapper." >&2
  exit 33
fi
verify_jar "$TMP"
mv "$TMP" "$JAR"
echo "Verified official Gradle 8.9 Wrapper JAR: $JAR"

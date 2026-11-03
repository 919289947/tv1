#!/usr/bin/env bash
# Build the Next.js frontend as a static export and copy it into Android assets.
# All previous assets are cleared first; failures leave no stale app payload.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRONT="$ROOT/frontend"
ANDROID_ASSETS="$ROOT/android/app/src/main/assets"
API_DIR="$FRONT/src/app/api"
TMP_API="$FRONT/.android-tv-api-routes-backup"
OUT="$FRONT/out"

restore_api() {
  if [[ -d "$TMP_API" ]]; then
    if [[ -e "$API_DIR" ]]; then
      echo "ERROR: API directory was recreated while static build was running; refusing unsafe restore." >&2
      return 1
    fi
    mv "$TMP_API" "$API_DIR"
  fi
}
cleanup() {
  local status=$?
  set +e
  restore_api
  local restore_status=$?
  if [[ $status -eq 0 && $restore_status -ne 0 ]]; then
    status=$restore_status
  fi
  if [[ $status -ne 0 ]]; then
    rm -rf "$ANDROID_ASSETS"/* "$ANDROID_ASSETS"/.[!.]* "$OUT"
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ ! -f "$FRONT/package-lock.json" || ! -f "$FRONT/package.json" ]]; then
  echo "ERROR: frontend package manifest/lockfile missing." >&2
  exit 20
fi
if [[ -e "$TMP_API" ]]; then
  echo "ERROR: found stale API backup directory: $TMP_API" >&2
  exit 21
fi
if [[ ! -f "$FRONT/src/lib/android-tv-api.ts" ]] || ! grep -q 'ANDROID_TV_API_BRIDGE_READY' "$FRONT/src/lib/android-tv-api.ts"; then
  echo "ERROR: Android TV API bridge marker missing; refusing static export." >&2
  exit 22
fi

# A static route-signature check, not a substitute for integration testing.
python3 "$ROOT/tools/check-api-coverage.py"

# Remove previous outputs before attempting this build so a failed build cannot
# leave a stale APK payload available to a later Gradle invocation.
mkdir -p "$ANDROID_ASSETS"
rm -rf "$ANDROID_ASSETS"/* "$ANDROID_ASSETS"/.[!.]* "$OUT"
rm -rf "$ROOT/android/app/build/outputs/apk" "$ROOT/dist"

cd "$FRONT"
npm ci
npm run typecheck
npm test

# Next.js static export cannot include Next Route Handlers. On Android they are
# replaced by android-tv-api.ts + MainActivity's native network bridge.
mv "$API_DIR" "$TMP_API"
ANDROID_TV_BUILD=1 npm run build
restore_api

if [[ ! -f "$OUT/index.html" || ! -d "$OUT/_next/static" ]]; then
  echo "ERROR: Next.js static export is incomplete." >&2
  exit 23
fi
python3 "$ROOT/tools/verify-web-assets.py" "$OUT"
cp -a "$OUT/." "$ANDROID_ASSETS/"
python3 "$ROOT/tools/verify-web-assets.py" "$ANDROID_ASSETS"
echo "Frontend assets copied into: $ANDROID_ASSETS"
echo "Next step: run tools/build-apk.sh (requires JDK 17 + Android SDK 35)."

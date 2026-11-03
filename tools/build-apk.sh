#!/usr/bin/env bash
# Full fail-closed build: Next.js static export -> Gradle APK -> APK validation.
# The dist artifact is created only after Gradle and all APK checks succeed.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID="$ROOT/android"
APK="$ANDROID/app/build/outputs/apk/debug/app-debug.apk"
DIST="$ROOT/dist"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    echo "BUILD FAILED: removing all APK outputs so no stale/partial APK can be mistaken for success." >&2
    rm -rf "$DIST" "$ANDROID/app/build/outputs/apk"
  fi
  exit "$status"
}
trap cleanup EXIT

rm -rf "$DIST" "$ANDROID/app/build/outputs/apk"

if ! command -v java >/dev/null 2>&1; then
  echo "ERROR: JDK 17 is required (java command not found)." >&2
  exit 39
fi
JAVA_VERSION="$(java -version 2>&1 | awk -F '"' '/version/ {print $2; exit}')"
JAVA_MAJOR="${JAVA_VERSION%%.*}"
if [[ -z "$JAVA_MAJOR" || "$JAVA_MAJOR" -lt 17 ]]; then
  echo "ERROR: JDK 17 or newer is required; detected ${JAVA_VERSION:-unknown}." >&2
  exit 39
fi

# Rebuild assets from a clean frontend output. This script itself deletes stale assets on failure.
bash "$ROOT/tools/build-android-tv.sh"

if [[ -z "$SDK" ]]; then
  echo "ERROR: ANDROID_SDK_ROOT or ANDROID_HOME must point to an installed Android SDK." >&2
  exit 40
fi
SDK="$(cd "$SDK" && pwd)"
export ANDROID_SDK_ROOT="$SDK"
export ANDROID_HOME="$SDK"
AAPT="$SDK/build-tools/35.0.0/aapt"
APKSIGNER="$SDK/build-tools/35.0.0/apksigner"
if [[ ! -f "$SDK/platforms/android-35/android.jar" || ! -x "$AAPT" || ! -x "$APKSIGNER" ]]; then
  echo "ERROR: Android SDK Platform 35 + Build Tools 35.0.0 are required." >&2
  exit 41
fi

bash "$ROOT/tools/bootstrap-gradle-wrapper.sh"
chmod +x "$ANDROID/gradlew"
(cd "$ANDROID" && ./gradlew --no-daemon --stacktrace :app:clean :app:assembleDebug)

if [[ ! -s "$APK" ]]; then
  echo "ERROR: Gradle reported success but app-debug.apk is missing/empty." >&2
  exit 42
fi
python3 "$ROOT/tools/verify-apk.py" "$APK" --aapt "$AAPT"
"$APKSIGNER" verify --verbose "$APK"

mkdir -p "$DIST"
cp "$APK" "$DIST/LibreTV-TV-debug.apk"
python3 "$ROOT/tools/verify-apk.py" "$DIST/LibreTV-TV-debug.apk" --aapt "$AAPT"
sha256sum "$DIST/LibreTV-TV-debug.apk" > "$DIST/LibreTV-TV-debug.apk.sha256"
echo "BUILD SUCCESS: $DIST/LibreTV-TV-debug.apk"
echo "SHA-256: $(awk '{print $1}' "$DIST/LibreTV-TV-debug.apk.sha256")"

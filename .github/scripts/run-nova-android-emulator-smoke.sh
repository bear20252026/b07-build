#!/bin/sh

set -eu

evidence_dir="${RUNNER_TEMP:?RUNNER_TEMP is required}/nova-android-emulator-smoke"
mkdir -p "$evidence_dir"

capture_evidence() {
  adb logcat -d -v threadtime > "$evidence_dir/logcat.txt" 2>&1 || true
  adb exec-out screencap -p > "$evidence_dir/nova-startup.png" 2>/dev/null || true
}

trap capture_evidence EXIT

apk=$(find apps/desktop-shell/src-tauri/gen/android/app/build/outputs/apk/universal/release -type f -name 'app-universal-release-unsigned.apk' | sort | head -n 1)
test -n "$apk" && test -f "$apk"

build_tools_dir=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V | tail -n 1)
zipalign_bin="$ANDROID_HOME/build-tools/$build_tools_dir/zipalign"
apksigner_bin="$ANDROID_HOME/build-tools/$build_tools_dir/apksigner"
keystore="$evidence_dir/nova-emulator-smoke.jks"
signed_apk="$evidence_dir/NOVA-emulator-smoke.apk"

keytool -genkeypair -keystore "$keystore" -storepass android -keypass android -alias nova-emulator-smoke -keyalg RSA -keysize 2048 -validity 1 -dname 'CN=NOVA Emulator Smoke, O=NOVA, C=US' -noprompt
"$zipalign_bin" -f -p 4 "$apk" "$signed_apk.aligned"
"$apksigner_bin" sign --ks "$keystore" --ks-key-alias nova-emulator-smoke --ks-pass pass:android --key-pass pass:android --out "$signed_apk" "$signed_apk.aligned"
"$apksigner_bin" verify --verbose "$signed_apk"
rm -f "$signed_apk.aligned" "$keystore"

adb install -r "$signed_apk"
adb logcat -c
adb shell monkey -p com.bear20252026.nova 1
startup_deadline=90
startup_elapsed=0
while [ "$startup_elapsed" -lt "$startup_deadline" ]; do
  adb shell dumpsys activity activities > "$evidence_dir/activity.txt" 2>&1 || true
  if grep -q 'com.bear20252026.nova/.MainActivity' "$evidence_dir/activity.txt"; then
    break
  fi
  sleep 1
  startup_elapsed=$((startup_elapsed + 1))
done

adb shell dumpsys window windows > "$evidence_dir/window.txt"
adb shell uiautomator dump /sdcard/nova-ui.xml >/dev/null 2>&1 || true
adb pull /sdcard/nova-ui.xml "$evidence_dir/nova-ui.xml" >/dev/null 2>&1 || true
capture_evidence

grep -q 'com.bear20252026.nova/.MainActivity' "$evidence_dir/activity.txt"
grep -q 'com.bear20252026.nova' "$evidence_dir/window.txt"
if grep -E 'Process: com\.bear20252026\.nova|NOVA mobile shell failed to run|Unable to start activity:.*com\.bear20252026\.nova' "$evidence_dir/logcat.txt"; then
  exit 1
fi

#!/bin/sh

set -u

status_file="${RUNNER_TEMP:?RUNNER_TEMP is required}/nova-android-emulator-smoke/smoke-status.txt"
evidence_dir="${RUNNER_TEMP:?RUNNER_TEMP is required}/nova-android-emulator-smoke"
mkdir -p "$evidence_dir"
status=failed
reason=script-exited-before-pass

capture_evidence() {
  timeout 20 adb logcat -d -v threadtime > "$evidence_dir/logcat.txt" 2>&1 || true
  timeout 20 adb exec-out screencap -p > "$evidence_dir/nova-startup.png" 2>/dev/null || true
}

finish() {
  exit_code=$?
  capture_evidence
  printf 'status=%s\nreason=%s\nexit_code=%s\n' "$status" "$reason" "$exit_code" > "$status_file"
  exit 0
}

fail() {
  reason=$1
  exit 0
}

trap finish EXIT

apk=$(find apps/desktop-shell/src-tauri/gen/android/app/build/outputs/apk/universal/release -type f -name 'app-universal-release-unsigned.apk' | sort | head -n 1)
test -n "$apk" && test -f "$apk" || fail apk-not-found

build_tools_dir=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V | tail -n 1)
zipalign_bin="$ANDROID_HOME/build-tools/$build_tools_dir/zipalign"
apksigner_bin="$ANDROID_HOME/build-tools/$build_tools_dir/apksigner"
keystore="$evidence_dir/nova-emulator-smoke.jks"
signed_apk="$evidence_dir/NOVA-emulator-smoke.apk"

keytool -genkeypair -keystore "$keystore" -storepass android -keypass android -alias nova-emulator-smoke -keyalg RSA -keysize 2048 -validity 1 -dname 'CN=NOVA Emulator Smoke, O=NOVA, C=US' -noprompt || fail ephemeral-key-failed
"$zipalign_bin" -f -p 4 "$apk" "$signed_apk.aligned" || fail zipalign-failed
"$apksigner_bin" sign --ks "$keystore" --ks-key-alias nova-emulator-smoke --ks-pass pass:android --key-pass pass:android --out "$signed_apk" "$signed_apk.aligned" || fail sign-failed
"$apksigner_bin" verify --verbose "$signed_apk" || fail verify-signature-failed
rm -f "$signed_apk.aligned" "$keystore"

timeout 30 adb wait-for-device || fail device-not-ready
install_log="$evidence_dir/install.txt"
: > "$install_log"
printf 'preinstall-uninstall\n' >> "$install_log"
timeout 30 adb uninstall com.bear20252026.nova >> "$install_log" 2>&1 || true
install_attempt=1
installed=0
while [ "$install_attempt" -le 3 ]; do
  printf 'attempt=%s\n' "$install_attempt" >> "$install_log"
  if timeout 120 adb install --no-streaming -r -d "$signed_apk" >> "$install_log" 2>&1; then
    installed=1
    break
  fi
  sleep 5
  install_attempt=$((install_attempt + 1))
done
[ "$installed" -eq 1 ] || fail install-timeout-or-failed
timeout 20 adb shell pm path com.bear20252026.nova > "$evidence_dir/package-path.txt" 2>&1 || fail package-path-query-failed
grep -q '^package:' "$evidence_dir/package-path.txt" || fail package-path-missing
timeout 20 adb logcat -c || fail logcat-clear-failed
timeout 30 adb shell monkey -p com.bear20252026.nova 1 || fail launch-timeout-or-failed

startup_deadline=90
startup_elapsed=0
while [ "$startup_elapsed" -lt "$startup_deadline" ]; do
  timeout 10 adb shell dumpsys activity activities > "$evidence_dir/activity.txt" 2>&1 || true
  if grep -q 'com.bear20252026.nova/.MainActivity' "$evidence_dir/activity.txt"; then
    break
  fi
  sleep 1
  startup_elapsed=$((startup_elapsed + 1))
done

timeout 20 adb shell dumpsys window windows > "$evidence_dir/window.txt" 2>&1 || true
timeout 20 adb shell uiautomator dump /sdcard/nova-ui.xml >/dev/null 2>&1 || true
timeout 20 adb pull /sdcard/nova-ui.xml "$evidence_dir/nova-ui.xml" >/dev/null 2>&1 || true

grep -q 'com.bear20252026.nova/.MainActivity' "$evidence_dir/activity.txt" || fail main-activity-not-foreground
grep -q 'com.bear20252026.nova' "$evidence_dir/window.txt" || fail nova-window-not-present
if grep -E 'Process: com\.bear20252026\.nova|NOVA mobile shell failed to run|Unable to start activity:.*com\.bear20252026\.nova' "$evidence_dir/logcat.txt"; then
  fail nova-runtime-error
fi

# MainActivity can be resumed while Android still displays its white system Splash.
# Wait past the 1.25s React brand transition and require a non-empty app frame.
render_elapsed=0
rendered=0
while [ "$render_elapsed" -lt 30 ]; do
  timeout 20 adb exec-out screencap -p > "$evidence_dir/nova-startup.png" 2>/dev/null || true
  if python3 .github/scripts/verify-nova-android-frame.py "$evidence_dir/nova-startup.png" > "$evidence_dir/frame-check.txt" 2>&1; then
    rendered=1
    break
  fi
  sleep 2
  render_elapsed=$((render_elapsed + 2))
done
capture_evidence
[ "$rendered" -eq 1 ] || fail workbench-frame-not-rendered

status=passed
reason=main-activity-and-window-present

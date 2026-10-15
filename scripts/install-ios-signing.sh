#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-install}" = "cleanup" ]; then
if [ "$(uname)" = "Darwin" ] && [ -f .private/signing/keychain-path ]; then
  if [ -f .private/signing/previous-keychain ]; then
    previous_keychain="$(cat .private/signing/previous-keychain)"
    security default-keychain -d user -s "$previous_keychain" || true
  fi
  if [ -f .private/signing/previous-keychains.json ]; then
    python3 - <<'PY' || true
import json, pathlib, subprocess
keychains = json.loads(pathlib.Path('.private/signing/previous-keychains.json').read_text())
subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', *keychains], check=True)
PY
  fi
  security delete-keychain "$(cat .private/signing/keychain-path)" || true
  if [ -f .private/signing/installed-profile ]; then
    installed_profile="$(cat .private/signing/installed-profile)"
    if [ -f .private/signing/previous-profile.mobileprovision ]; then
      cp .private/signing/previous-profile.mobileprovision "$installed_profile"
    else
      rm -f "$installed_profile"
    fi
  fi
fi
rm -rf .private
rm -f source/apps/mobile/android/app/ci-upload.keystore source/apps/mobile/secrets/google-services-prod.json source/apps/mobile/android/app/google-services.json
  exit 0
fi

IOS_KEYCHAIN_PASSWORD="$(openssl rand -base64 32)"

mkdir -p .private/signing "$HOME/Library/MobileDevice/Provisioning Profiles"
keychain_path="$RUNNER_TEMP/mobile-signing.keychain-db"
security default-keychain -d user | python3 -c 'import shlex, sys; print(shlex.split(sys.stdin.read())[0])' > .private/signing/previous-keychain
security list-keychains -d user | python3 -c 'import json, shlex, sys; json.dump(shlex.split(sys.stdin.read()), sys.stdout)' > .private/signing/previous-keychains.json
printf '%s' "$keychain_path" > .private/signing/keychain-path
printf '%s' "$IOS_DISTRIBUTION_CERT_BASE64" | base64 --decode > .private/signing/distribution.p12
security create-keychain -p "$IOS_KEYCHAIN_PASSWORD" "$keychain_path"
security set-keychain-settings -lut 21600 "$keychain_path"
security unlock-keychain -p "$IOS_KEYCHAIN_PASSWORD" "$keychain_path"
security import .private/signing/distribution.p12 -P "$IOS_CERT_PASSWORD" -t cert -f pkcs12 -k "$keychain_path"
python3 - <<'PY'
import json, pathlib, subprocess
root = pathlib.Path('.private/signing')
subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', (root / 'keychain-path').read_text(), *json.loads((root / 'previous-keychains.json').read_text())], check=True)
PY
security default-keychain -d user -s "$keychain_path"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$IOS_KEYCHAIN_PASSWORD" "$keychain_path"

if [ "$MOBILE_BUILD_TARGET" = "ios-adhoc" ]; then
  profile_base64="$IOS_PROFILE_ADHOC_BASE64"
else
  profile_base64="$IOS_PROFILE_APP_BASE64"
fi
printf '%s' "$profile_base64" | base64 --decode > .private/signing/app.mobileprovision
security cms -D -i .private/signing/app.mobileprovision > .private/signing/app.plist
security find-identity -v -p codesigning "$keychain_path" > .private/signing/identities
python3 - <<'PY'
import datetime, hashlib, json, os, pathlib, plistlib, shutil
root = pathlib.Path('.private/signing')
release = json.loads(pathlib.Path('.private/release.json').read_text())
profile = plistlib.loads((root / 'app.plist').read_bytes())
if os.environ['APPLE_TEAM_ID'] not in profile.get('TeamIdentifier', []):
    raise SystemExit('描述文件 Team ID 与账号不匹配')
identifier = profile.get('Entitlements', {}).get('application-identifier', '')
if not identifier.endswith('.' + release['bundle_id']):
    raise SystemExit('描述文件不是 Bundle ID 的精确描述文件')
if profile['ExpirationDate'] <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
    raise SystemExit('描述文件已过期')
if profile.get('ProvisionsAllDevices') or profile.get('Entitlements', {}).get('get-task-allow'):
    raise SystemExit('请提供 Distribution 描述文件，不能使用 Enterprise/Development')
adhoc = bool(profile.get('ProvisionedDevices'))
if adhoc != (release['build_target'] == 'ios-adhoc'):
    raise SystemExit('Ad Hoc/App Store 描述文件类型与构建目标不匹配')
identities = (root / 'identities').read_text()
if not any(hashlib.sha1(certificate).hexdigest().upper() in identities for certificate in profile.get('DeveloperCertificates', [])):
    raise SystemExit('P12 私钥证书与描述文件中的证书不匹配')
name, uuid = profile['Name'], profile['UUID']
if any(char in name + uuid for char in '\r\n'):
    raise SystemExit('描述文件包含非法名称')
destination = pathlib.Path.home() / 'Library/MobileDevice/Provisioning Profiles' / (uuid + '.mobileprovision')
if destination.exists():
    shutil.copyfile(destination, root / 'previous-profile.mobileprovision')
shutil.copyfile(root / 'app.mobileprovision', destination)
(root / 'installed-profile').write_text(str(destination))
with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
    output.write('app_name=' + name + '\n')
print('[signing]  Team/Bundle/描述文件类型/有效期/证书匹配校验通过')
PY

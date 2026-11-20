"""Publish a verified APK and a versioned-download manifest to LeWork OSS."""
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import oss2

print('Reading and verifying local APK', flush=True)
manifest = json.loads(Path('dist/manifest.json').read_text())
if manifest['artifact_type'] != 'apk' or manifest['release_env'] not in ('test', 'production'):
    raise ValueError('Expected an Android APK in a known environment')
name = manifest['artifact_name']
if Path(name).name != name or not name.endswith('.apk'):
    raise ValueError('Invalid APK name')
apk = Path('dist') / name
content = apk.read_bytes()
if len(content) != manifest['bytes'] or hashlib.sha256(content).hexdigest() != manifest['sha256']:
    raise ValueError('APK does not match verified build manifest')
endpoint = os.environ.get('OSS_UPLOAD_ENDPOINT') or 'https://oss-cn-hangzhou.aliyuncs.com'
if endpoint not in ('https://oss-cn-hangzhou.aliyuncs.com', 'https://oss-accelerate.aliyuncs.com'):
    raise ValueError('Unsupported OSS upload endpoint')
print(f'OSS upload endpoint: {endpoint}', flush=True)
bucket = oss2.Bucket(oss2.Auth(os.environ['OSS_ACCESS_KEY_ID'], os.environ['OSS_ACCESS_KEY_SECRET']),
                     endpoint, 'lework-saas', connect_timeout=60)
mode = manifest.get('customer_mode', 'standard')
if mode not in ('standard', 'shanjian'):
    raise ValueError('Unknown customer mode')
mode_path = '/shanjian' if mode == 'shanjian' else ''
root = f"mobile/lework{mode_path}/{manifest['release_env']}"
key = f'{root}/{name}'
print(f'Checking existing object: {key}', flush=True)
if bucket.object_exists(key) and hashlib.sha256(bucket.get_object(key).read()).hexdigest() != manifest['sha256']:
    raise ValueError('Existing APK differs; use a new version/build number')
latest_key = f'{root}/latest.json'
print('Checking latest manifest', flush=True)
try:
    old = json.loads(bucket.get_object(latest_key).read())
    if int(old['build_number']) > int(manifest['build_number']):
        raise ValueError('Refusing mobile build-number downgrade')
except oss2.exceptions.NoSuchKey:
    pass
last_percent = -10

def progress(consumed, total):
    global last_percent
    percent = int(consumed * 100 / total) if total else 0
    if percent >= last_percent + 5 or consumed == total:
        print(f'Upload: {consumed}/{total} bytes ({percent}%)', flush=True)
        last_percent = percent

print(f'Uploading APK: {len(content)} bytes', flush=True)
bucket.put_object_from_file(key, str(apk), headers={'Content-Type': 'application/vnd.android.package-archive'}, progress_callback=progress)
url = f'https://download.lework.insmtx.com/{key}'
print(f'Verifying public APK download: {url}', flush=True)
with urllib.request.urlopen(url, timeout=60) as response:
    if hashlib.sha256(response.read()).hexdigest() != manifest['sha256']:
        raise ValueError('Public APK verification failed')
latest = {k: manifest[k] for k in ('version', 'build_number', 'sha256', 'bytes')}
latest['url'] = url
print('Publishing latest.json', flush=True)
bucket.put_object(latest_key, json.dumps(latest).encode(), headers={'Content-Type': 'application/json', 'Cache-Control': 'no-cache, must-revalidate'})
print(f'Published {url}')

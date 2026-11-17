"""Publish a verified APK and a versioned-download manifest to LeWork OSS."""
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import oss2

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
bucket = oss2.Bucket(oss2.Auth(os.environ['OSS_ACCESS_KEY_ID'], os.environ['OSS_ACCESS_KEY_SECRET']),
                     'https://oss-cn-hangzhou.aliyuncs.com', 'lework-saas')
root = f"mobile/lework/{manifest['release_env']}"
key = f'{root}/{name}'
if bucket.object_exists(key) and hashlib.sha256(bucket.get_object(key).read()).hexdigest() != manifest['sha256']:
    raise ValueError('Existing APK differs; use a new version/build number')
latest_key = f'{root}/latest.json'
try:
    old = json.loads(bucket.get_object(latest_key).read())
    if int(old['build_number']) > int(manifest['build_number']):
        raise ValueError('Refusing mobile build-number downgrade')
except oss2.exceptions.NoSuchKey:
    pass
bucket.put_object_from_file(key, str(apk), headers={'Content-Type': 'application/vnd.android.package-archive'})
url = f'https://lework-saas.oss-cn-hangzhou.aliyuncs.com/{key}'
with urllib.request.urlopen(url, timeout=300) as response:
    if hashlib.sha256(response.read()).hexdigest() != manifest['sha256']:
        raise ValueError('Public APK verification failed')
latest = {k: manifest[k] for k in ('version', 'build_number', 'sha256', 'bytes')}
latest['url'] = url
bucket.put_object(latest_key, json.dumps(latest).encode(), headers={'Content-Type': 'application/json', 'Cache-Control': 'no-cache, must-revalidate'})
print(f'Published {url}')

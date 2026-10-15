import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const toolchain = JSON.parse(readFileSync(new URL('./toolchain.json', import.meta.url), 'utf8'));

//#region 对齐已验证原生预编译文件
const [sourceRoot, platform] = process.argv.slice(2);
if (!['android', 'ios'].includes(platform)) throw new Error('platform 须为 android/ios');
const root = path.resolve(sourceRoot, 'node_modules/react-native-audio-api');
if (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version !== toolchain.audioApi) throw new Error('音频库版本变化，需要更新预编译校验清单');
const archives = platform === 'ios' ? Object.keys(toolchain.archives) : ['android.zip', 'jniLibs.zip'];
const external = path.join(root, 'common/cpp/audioapi/external');
const temporary = mkdtempSync(path.join(tmpdir(), 'mobile-native-'));
try {
  for (const name of archives) {
    const destination = name === 'jniLibs.zip' ? path.join(root, 'android/src/main') : external;
    if (existsSync(path.join(destination, name.replace('.zip', '')))) throw new Error('原生预编译目录已存在；请使用全新 checkout');
    const archive = path.join(temporary, name);
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors', '--connect-timeout', '30', '--max-time', '300', `https://github.com/software-mansion-labs/rn-audio-libs/releases/download/${toolchain.audioTag}/${name}`, '-o', archive], { stdio: 'inherit' });
    if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== toolchain.archives[name]) throw new Error(`原生预编译 SHA256 不匹配：${name}`);
    execFileSync('unzip', ['-q', '-o', archive, '-d', destination]);
    rmSync(path.join(destination, '__MACOSX'), { recursive: true, force: true });
    if (!existsSync(path.join(destination, name.replace('.zip', '')))) throw new Error(`原生压缩包缺少预期目录：${name}`);
  }
  if (platform === 'ios') execFileSync('bash', ['scripts/download-prebuilt-binaries.sh', 'ios'], { cwd: root, stdio: 'inherit' });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
console.log(`[native] ${platform} 预编译文件校验通过`);
//#endregion

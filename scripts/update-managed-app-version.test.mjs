import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { updateManagedAppVersion } from './update-managed-app-version.mjs';

function createMobileFixture({
  appConfigVersion = '1.0.0',
  packageVersion = '1.0.0',
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-managed-version-'));
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'mobile', version: packageVersion, private: true }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, 'app.config.ts'),
    [
      'const config = {',
      "  name: 'Mobile',",
      `  version: '${appConfigVersion}',`,
      '};',
      'export default config;',
      '',
    ].join('\n'),
  );
  return root;
}

describe('update-managed-app-version', () => {
  test('succeeds when package.json and app.config.ts already match the release version', () => {
    const root = createMobileFixture({
      appConfigVersion: '1.0.9',
      packageVersion: '1.0.9',
    });
    try {
      const result = updateManagedAppVersion({ root, version: '1.0.9' });

      assert.equal(result.packageJson.previousVersion, '1.0.9');
      assert.equal(result.packageJson.changed, false);
      assert.equal(result.appConfig.previousVersion, '1.0.9');
      assert.equal(result.appConfig.changed, false);
      assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '1.0.9');
      assert.match(readFileSync(path.join(root, 'app.config.ts'), 'utf8'), /version: '1\.0\.9'/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('updates package.json and app.config.ts when they are behind the release version', () => {
    const root = createMobileFixture({
      appConfigVersion: '1.0.8',
      packageVersion: '1.0.8',
    });
    try {
      const result = updateManagedAppVersion({ root, version: '1.0.9' });

      assert.equal(result.packageJson.previousVersion, '1.0.8');
      assert.equal(result.packageJson.changed, true);
      assert.equal(result.appConfig.previousVersion, '1.0.8');
      assert.equal(result.appConfig.changed, true);
      assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '1.0.9');
      assert.match(readFileSync(path.join(root, 'app.config.ts'), 'utf8'), /version: '1\.0\.9'/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('fails clearly when app.config.ts has no literal version field', () => {
    const root = createMobileFixture();
    try {
      writeFileSync(path.join(root, 'app.config.ts'), 'export default { name: "Mobile" };\n');

      assert.throws(
        () => updateManagedAppVersion({ root, version: '1.0.9' }),
        /Could not find version field in app\.config\.ts/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_PATTERN = /(version:\s*['"])(\d+\.\d+\.\d+)(['"])/;

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error(`Invalid MOBILE_VERSION: ${version}`);
  }
}

export function updateManagedAppVersion({ root = process.cwd(), version }) {
  validateVersion(version);

  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const previousPackageVersion = pkg.version ?? '';
  const packageChanged = previousPackageVersion !== version;
  if (packageChanged) {
    pkg.version = version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  const appConfigPath = path.join(root, 'app.config.ts');
  const appConfig = readFileSync(appConfigPath, 'utf8');
  const versionMatch = appConfig.match(VERSION_PATTERN);
  if (!versionMatch) {
    throw new Error('Could not find version field in app.config.ts');
  }

  const previousAppConfigVersion = versionMatch[2];
  const appConfigChanged = previousAppConfigVersion !== version;
  if (appConfigChanged) {
    writeFileSync(appConfigPath, appConfig.replace(VERSION_PATTERN, `$1${version}$3`));
  }

  return {
    appConfig: {
      changed: appConfigChanged,
      previousVersion: previousAppConfigVersion,
      version,
    },
    packageJson: {
      changed: packageChanged,
      previousVersion: previousPackageVersion,
      version,
    },
  };
}

function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const version = process.env.MOBILE_VERSION;
  const result = updateManagedAppVersion({ root, version });

  if (result.packageJson.changed) {
    console.log(`[version] package.json version updated ${result.packageJson.previousVersion} -> ${version}`);
  } else {
    console.log(`[version] package.json already at ${version}, skipping update`);
  }

  if (result.appConfig.changed) {
    console.log(`[version] app.config.ts version updated ${result.appConfig.previousVersion} -> ${version}`);
  } else {
    console.log(`[version] app.config.ts already at ${version}, skipping update`);
  }

  console.log(`[version] managed app version ready: ${version}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (relative) => readFile(resolve(root, relative), 'utf8');
const desktopPackage = JSON.parse(await read('apps/desktop-shell/package.json'));
const cargoToml = await read('apps/desktop-shell/src-tauri/Cargo.toml');
const tauriConfig = JSON.parse(await read('apps/desktop-shell/src-tauri/tauri.conf.json'));
const publishScript = await read('publish-workbench-home-ui.ps1');
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = [desktopPackage.version, cargoVersion, tauriConfig.version];

if (versions.some((version) => typeof version !== 'string') || new Set(versions).size !== 1) {
  throw new Error(`desktop-release-version-mismatch: ${versions.join(', ')}`);
}

const [version] = versions;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`desktop-release-version-invalid: ${version}`);
if (!publishScript.includes(`AI Work OS_${version}_x64-setup.exe`) || !publishScript.includes(`version = '${version}'`)) {
  throw new Error(`desktop-release-publish-script-mismatch: ${version}`);
}

console.log(`desktop-release-version-ok=${version}`);

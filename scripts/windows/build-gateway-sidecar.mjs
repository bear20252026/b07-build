import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const binariesDirectory = join(repositoryRoot, 'apps/desktop-shell/src-tauri/binaries');
const bundlePath = join(binariesDirectory, 'awo-runtime-gateway-bundle.cjs');
const seaConfigurationPath = join(binariesDirectory, 'awo-runtime-gateway-sea.json');
const seaBlobPath = join(binariesDirectory, 'awo-runtime-gateway-sea.blob');
const windowsBinaryPath = join(binariesDirectory, 'awo-runtime-gateway-x86_64-pc-windows-msvc.exe');
const postjectCliPath = join(repositoryRoot, 'node_modules', 'postject', 'dist', 'cli.js');
const NODE_SEA_SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

mkdirSync(binariesDirectory, { recursive: true });
for (const generatedPath of [bundlePath, seaConfigurationPath, seaBlobPath]) rmSync(generatedPath, { force: true });

await build({
  entryPoints: [join(repositoryRoot, 'apps/runtime-gateway/src/main.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: bundlePath,
  external: ['node:*'],
  legalComments: 'none',
  sourcemap: false,
  minify: true,
});

if (process.platform !== 'win32') {
  console.log(`Gateway bundle prepared for inspection: ${bundlePath}`);
  process.exit(0);
}

rmSync(windowsBinaryPath, { force: true });
const seaConfiguration = {
  main: bundlePath,
  output: seaBlobPath,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  execArgv: ['--experimental-sqlite', '--no-warnings'],
  execArgvExtension: 'none',
};
writeFileSync(seaConfigurationPath, JSON.stringify(seaConfiguration, null, 2), 'utf8');
// Node 24 LTS generates a preparation blob; postject applies the documented PE resource and sentinel fuse.
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigurationPath], { cwd: binariesDirectory, stdio: 'inherit' });
copyFileSync(process.execPath, windowsBinaryPath);
execFileSync(process.execPath, [postjectCliPath, windowsBinaryPath, 'NODE_SEA_BLOB', seaBlobPath, '--sentinel-fuse', NODE_SEA_SENTINEL_FUSE], { cwd: binariesDirectory, stdio: 'inherit' });
for (const generatedPath of [seaConfigurationPath, seaBlobPath, bundlePath]) rmSync(generatedPath, { force: true });
console.log(`Windows Gateway sidecar prepared: ${windowsBinaryPath}`);

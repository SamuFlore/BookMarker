import { existsSync } from 'node:fs';
import { access, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

const targets = [
  { name: 'chrome', manifest: 'manifest.chrome.json' },
  { name: 'firefox', manifest: 'manifest.firefox.json' },
];

const entries = ['background.js', 'popup.js'];
const assets = ['popup.html', 'popup.css'];
const required = [
  ...entries.map(name => path.join(src, name)),
  ...assets.map(name => path.join(src, name)),
  ...targets.map(target => path.join(src, target.manifest)),
  path.join(src, 'icons'),
];

function resolveEsbuild() {
  const candidates = [
    path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(root, '..', 'QRScan', 'node_modules', 'esbuild', 'bin', 'esbuild'),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

async function main() {
  const missing = [];
  for (const entry of required) {
    try {
      await access(entry);
    } catch {
      missing.push(path.relative(root, entry));
    }
  }
  if (missing.length) {
    console.error('构建失败：缺少必需文件：' + missing.join(', '));
    process.exitCode = 1;
    return;
  }

  const esbuild = resolveEsbuild();
  if (!esbuild) {
    console.error('构建失败：找不到 esbuild（请在本目录或 ../QRScan 下安装依赖）');
    process.exitCode = 1;
    return;
  }

  await rm(dist, { recursive: true, force: true });

  for (const target of targets) {
    const outDir = path.join(dist, target.name);
    await mkdir(outDir, { recursive: true });

    const bundle = spawnSync(process.execPath, [
      esbuild,
      ...entries.map(name => path.join(src, name)),
      '--bundle',
      '--platform=browser',
      '--format=iife',
      '--target=es2022',
      '--outdir=' + outDir,
      '--log-level=warning',
    ], { stdio: 'inherit' });
    if (bundle.error) throw bundle.error;
    if (bundle.status !== 0) {
      console.error('构建失败：esbuild 退出码 ' + bundle.status);
      process.exitCode = bundle.status || 1;
      return;
    }

    for (const asset of assets) {
      await cp(path.join(src, asset), path.join(outDir, asset));
    }
    await cp(path.join(src, 'icons'), path.join(outDir, 'icons'), { recursive: true });

    const manifest = JSON.parse(await readFile(path.join(src, target.manifest), 'utf8'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`已构建 dist/${target.name}（${manifest.name} ${manifest.version}）`);
  }
}

await main();

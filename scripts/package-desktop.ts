import { packager } from '@electron/packager';
import { rebuild } from '@electron/rebuild';
import { cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This personal build targets the current arm64 Mac only');
}

const paths = await packager({
  ...(process.env.XIAOZHAO_ELECTRON_ZIP_DIR ? { electronZipDir: resolve(process.env.XIAOZHAO_ELECTRON_ZIP_DIR) } : {}),
  dir: resolve('.'), out: resolve('dist/desktop'), name: '最佳拍档',
  appBundleId: 'local.xiaozhao.brain', platform: 'darwin', arch: 'arm64',
  electronVersion: '44.1.0', overwrite: true, asar: false,
  icon: resolve('assets/best-partners-icon.icns'),
  ignore: (path) => {
    if (path === '') return false;
    if (path.startsWith('/dist/native/')) return !['/dist/native/atomic-file-helper', '/dist/native/personal-archive.node'].includes(path);
    return !/^\/(?:package\.json$|node_modules(?:\/|$)|dist(?:$|\/(?:client|server|electron|native)(?:\/|$)))/u.test(path);
  },
  afterPrune: [async ({ buildPath, electronVersion, arch }) => {
    // Rebuild the staging copy only; Node-based unit tests keep their own ABI.
    await rebuild({ buildPath, electronVersion, arch, onlyModules: ['better-sqlite3'], force: true });
  }]
});
for (const path of paths) {
  const resources = join(path, '最佳拍档.app', 'Contents', 'Resources');
  await mkdir(resources, { recursive: true });
  await cp(resolve('templates/default-vault'), join(resources, 'templates', 'default-vault'), { recursive: true });
  await cp(resolve('browser-extension'), join(resources, 'clipper-extension'), { recursive: true });
  const zip = resolve('dist/best-partners-clipper.zip');
  await cp(zip, join(resources, 'best-partners-clipper.zip'));
  process.stdout.write(`${path}/最佳拍档.app\n`);
}

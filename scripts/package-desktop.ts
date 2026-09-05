import { packager } from '@electron/packager';
import { rebuild } from '@electron/rebuild';
import { resolve } from 'node:path';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This personal build targets the current arm64 Mac only');
}

const paths = await packager({
  dir: resolve('.'), out: resolve('dist/desktop'), name: '小兆大脑',
  appBundleId: 'local.xiaozhao.brain', platform: 'darwin', arch: 'arm64',
  electronVersion: '44.1.0', overwrite: true, asar: false,
  ignore: (path) => {
    if (path === '') return false;
    return !/^\/(?:package\.json$|node_modules(?:\/|$)|dist(?:$|\/(?:client|server|electron|native)(?:\/|$)))/u.test(path);
  },
  afterPrune: [async ({ buildPath, electronVersion, arch }) => {
    // Rebuild the staging copy only; Node-based unit tests keep their own ABI.
    await rebuild({ buildPath, electronVersion, arch, onlyModules: ['better-sqlite3'], force: true });
  }]
});
for (const path of paths) process.stdout.write(`${path}/小兆大脑.app\n`);

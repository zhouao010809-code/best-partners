import { execFile } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('NATIVE_BUILD_REQUIRES_MACOS_ARM64');
}
const outputDirectory = resolve('dist/native');
const outputPath = resolve(outputDirectory, 'atomic-file-helper');
await mkdir(outputDirectory, { recursive: true });
await promisify(execFile)('xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
  '-arch', 'arm64', '-mmacosx-version-min=13.0', resolve('native/macos/atomic-file-helper.c'), '-o', outputPath]);
await chmod(outputPath, 0o755);

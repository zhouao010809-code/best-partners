import { execFile } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveNodeHeaders } from './node-headers.js';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('NATIVE_BUILD_REQUIRES_MACOS_ARM64');
}
const outputDirectory = resolve('dist/native');
const testHooks = process.argv.includes('--test-hooks');
const personal = process.argv.includes('--personal');
if (personal && testHooks) throw new Error('PERSONAL_ARCHIVE_MUST_NOT_INCLUDE_TEST_HOOKS');
const headers = await resolveNodeHeaders();
const outputPath = resolve(outputDirectory, personal ? 'personal-archive.node' : testHooks ? 'sandbox-archive-test.node' : 'sandbox-archive.node');
await mkdir(outputDirectory, { recursive: true });
await promisify(execFile)('xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
  '-arch', 'arm64', '-mmacosx-version-min=13.0', '-DNAPI_VERSION=8', '-I', headers,
  ...(testHooks ? ['-DSANDBOX_ARCHIVE_TEST_HOOKS'] : []),
  ...(personal ? ['-DPERSONAL_ARCHIVE'] : []),
  '-bundle', '-undefined', 'dynamic_lookup', resolve('native/macos/sandbox-archive.c'), '-o', outputPath]);
await chmod(outputPath, 0o755);

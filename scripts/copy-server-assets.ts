import { cp, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve('src/server/db/migrations');
const destination = resolve('dist/server/db/migrations');

try {
  await stat(source);
} catch (error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    process.exit(0);
  }
  throw error;
}

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
await cp(resolve('src/server/attachments/pdf-worker.mjs'), resolve('dist/server/pdf-worker.mjs'));

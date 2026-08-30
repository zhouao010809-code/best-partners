import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const restartPendingSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  root: z.enum(['library', 'knowledge']),
  noteId: z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/i),
  rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
  upstreamVersion: z.string().min(1).max(256).regex(/^[a-z0-9._:-]+$/i),
  profileKey: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export type RestartPending = z.infer<typeof restartPendingSchema>;

export async function writeRestartPending(
  profileDirectory: string,
  value: RestartPending
): Promise<void> {
  let parsed: RestartPending;
  try {
    parsed = restartPendingSchema.parse(value);
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    await chmod(profileDirectory, 0o700);
  } catch {
    throw new Error('RESTART_PENDING_INVALID');
  }
  const target = join(profileDirectory, 'restart-pending.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch {
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw new Error('RESTART_PENDING_WRITE_FAILED');
  }
}

export async function loadRestartPending(
  profileDirectory: string
): Promise<RestartPending | undefined> {
  try {
    return restartPendingSchema.parse(
      JSON.parse(await readFile(join(profileDirectory, 'restart-pending.json'), 'utf8')) as unknown
    );
  } catch {
    return undefined;
  }
}

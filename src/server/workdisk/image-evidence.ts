import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const MAX_INPUT = 20 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024;
const evidenceSchema = z.strictObject({
  status: z.enum(['ready', 'unreadable', 'too-large', 'failed']), text: z.string().max(48000),
  labels: z.array(z.strictObject({ label: z.string().min(1).max(120), confidence: z.number().min(0).max(1) })).max(8),
  sampled: z.boolean()
});
export type ImageEvidence = z.infer<typeof evidenceSchema>;
export type ImageEvidenceReader = (bytes: Buffer, signal?: AbortSignal) => Promise<ImageEvidence>;

/** Spawn only the bundled helper, with image bytes on stdin and no source paths or environment. */
export function createImageEvidenceReader(input: { helperPath: string | URL; timeoutMs?: number }): ImageEvidenceReader {
  const helperPath = input.helperPath instanceof URL ? fileURLToPath(input.helperPath) : input.helperPath;
  if (!isAbsolute(helperPath) || helperPath.includes('\0')) throw new Error('IMAGE_HELPER_PATH_INVALID');
  return async (bytes, signal) => {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_INPUT) return { status: 'too-large', text: '', labels: [], sampled: false };
    return new Promise((resolve, reject) => {
      const child = spawn(helperPath, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: {} });
      const chunks: Buffer[] = [];
      let length = 0;
      let errorLength = 0;
      let settled = false;
      function finish(error?: unknown, value?: ImageEvidence) {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error !== undefined) { child.kill('SIGKILL'); reject(error); }
        else resolve(value!);
      }
      function abort() { finish(signal?.reason ?? new Error('IMAGE_RECOGNITION_ABORTED')); }
      const timer = setTimeout(() => finish(new Error('IMAGE_RECOGNITION_TIMEOUT')), input.timeoutMs ?? 15000);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_OUTPUT) { finish(new Error('IMAGE_EVIDENCE_LIMIT')); return; }
        if (!settled) chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errorLength += chunk.length;
        if (errorLength > 64 * 1024) finish(new Error('IMAGE_HELPER_FAILED'));
      });
      child.once('error', () => finish(new Error('IMAGE_HELPER_UNAVAILABLE')));
      child.stdin.on('error', () => { /* The exit handler reports a closed/failed helper without exposing bytes. */ });
      child.once('close', (code, exitSignal) => {
        if (settled) return;
        if (code !== 0 || exitSignal !== null) { finish(new Error('IMAGE_HELPER_FAILED')); return; }
        try { finish(undefined, evidenceSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
        catch { finish(new Error('IMAGE_EVIDENCE_INVALID')); }
      });
      if (signal?.aborted) { abort(); return; }
      child.stdin.end(bytes);
    });
  };
}

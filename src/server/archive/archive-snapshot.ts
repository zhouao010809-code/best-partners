import { z } from 'zod';
import { sha256Bytes } from '../vault/raw-bytes.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_INTENT_BYTES = 32 * 1024 * 1024;
const identitySchema = z.strictObject({
  dev: z.string().regex(/^(0|[1-9][0-9]{0,19})$/u),
  ino: z.string().regex(/^(0|[1-9][0-9]{0,19})$/u)
});
const memberFields = { path: z.string(), ...identitySchema.shape };
const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...memberFields, kind: z.literal('directory') }),
  z.strictObject({ ...memberFields, kind: z.literal('file'), bytesBase64: z.string().max(MAX_BYTES * 2) })
]);
const intentSchema = z.strictObject({
  version: z.literal(1), id: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u), root: identitySchema,
  source: z.string(), target: z.string(), sourceParent: identitySchema,
  targetParent: identitySchema, tree: z.array(entrySchema).min(1).max(MAX_ENTRIES)
});

export type ArchiveTreeEntry = z.infer<typeof entrySchema>;
export type ArchiveIntent = z.infer<typeof intentSchema>;
type Identity = z.infer<typeof identitySchema>;
type TreeStat = Identity & { kind: 'file' | 'directory'; size: number };
export interface ArchiveTreeReader {
  stat(path: string): TreeStat | null;
  list(path: string): readonly { name: string; kind: 'file' | 'directory' }[];
  read(path: string): Buffer;
}

function validName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\0/\\]/u.test(name)
    && Buffer.byteLength(name) <= 255 && Buffer.from(name).toString('utf8') === name;
}

export function validateArchivePaths(source: string, target: string): void {
  const a = source.split('/'); const b = target.split('/');
  if (a.length !== 3 || a[0] !== '01图书馆' || a[1] !== '小兆clipper'
    || b.length !== 4 || b[0] !== '01图书馆'
    || !/^来自(B站|YouTube|抖音|小红书|公众号|飞书|X推特|Reddit|小宇宙|独立站|个人|其他)$/u.test(b[1]!)
    || !/^[1-9][0-9]{3}-(0[1-9]|1[0-2])$/u.test(b[2]!)
    || ![...a, ...b].every(validName)) throw new Error('ARCHIVE_PATH_INVALID');
}

export function sameArchiveIdentity(a: Identity | null, b: Identity): boolean {
  return a !== null && a.dev === b.dev && a.ino === b.ino;
}

/** This is an observation, not a lock on the external producer. */
export function captureArchiveTree(port: ArchiveTreeReader, path: string): ArchiveTreeEntry[] {
  const entries: ArchiveTreeEntry[] = [];
  let totalBytes = 0;
  let rootDev: string;
  function walk(relative: string, depth: number): void {
    if (depth > 64 || entries.length >= MAX_ENTRIES) throw new Error('ARCHIVE_TREE_TOO_LARGE');
    const current = relative ? `${path}/${relative}` : path;
    const before = port.stat(current);
    if (!before) throw new Error('ARCHIVE_TREE_CHANGED');
    if (!relative) {
      if (before.kind !== 'directory') throw new Error('ARCHIVE_TREE_CHANGED');
      rootDev = before.dev;
    }
    if (before.dev !== rootDev) throw new Error('ARCHIVE_TREE_CHANGED');
    const common = { path: relative, dev: before.dev, ino: before.ino };
    if (before.kind === 'file') {
      if (before.size > 10 * 1024 * 1024 || totalBytes + before.size > MAX_BYTES) throw new Error('ARCHIVE_TREE_TOO_LARGE');
      const bytes = port.read(current);
      const after = port.stat(current);
      if (!sameArchiveIdentity(after, before) || after?.kind !== 'file'
        || after.size !== before.size || bytes.length !== before.size) throw new Error('ARCHIVE_TREE_CHANGED');
      totalBytes += bytes.length;
      entries.push({ ...common, kind: 'file', bytesBase64: bytes.toString('base64') });
      return;
    }
    entries.push({ ...common, kind: 'directory' });
    const sorted = () => [...port.list(current)].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const children = sorted();
    const names = new Set<string>();
    for (const child of children) {
      if (!validName(child.name) || names.has(child.name)) throw new Error('ARCHIVE_PATH_INVALID');
      names.add(child.name);
      const childPath = relative ? `${relative}/${child.name}` : child.name;
      const offset = entries.length;
      walk(childPath, depth + 1);
      if (entries[offset]?.kind !== child.kind) throw new Error('ARCHIVE_TREE_CHANGED');
    }
    if (!sameArchiveIdentity(port.stat(current), before)
      || JSON.stringify(children) !== JSON.stringify(sorted())) throw new Error('ARCHIVE_TREE_CHANGED');
  }
  walk('', 0);
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function validateIntent(value: unknown): ArchiveIntent {
  const intent = intentSchema.parse(value);
  validateArchivePaths(intent.source, intent.target);
  if (intent.tree[0]!.path !== '' || intent.tree[0]!.kind !== 'directory') throw new Error();
  const paths = new Map<string, ArchiveTreeEntry>();
  let total = 0; let previous: string | undefined;
  for (const entry of intent.tree) {
    const parts = entry.path === '' ? [] : entry.path.split('/');
    if (parts.length > 64 || !parts.every(validName) || entry.dev !== intent.root.dev
      || (previous !== undefined && entry.path <= previous)) throw new Error();
    if (parts.length && paths.get(parts.slice(0, -1).join('/'))?.kind !== 'directory') throw new Error();
    if (entry.kind === 'file') {
      const bytes = Buffer.from(entry.bytesBase64, 'base64');
      total += bytes.length;
      if (bytes.toString('base64') !== entry.bytesBase64 || bytes.length > 10 * 1024 * 1024 || total > MAX_BYTES) throw new Error();
    }
    previous = entry.path; paths.set(entry.path, entry);
  }
  if (intent.sourceParent.dev !== intent.root.dev || intent.targetParent.dev !== intent.root.dev) throw new Error();
  return intent;
}

export function sealArchiveIntent(value: unknown): Buffer {
  try {
    const payload = validateIntent(value);
    const bytes = Buffer.from(JSON.stringify({ payload, sha256: sha256Bytes(Buffer.from(JSON.stringify(payload))) }));
    if (bytes.length > MAX_INTENT_BYTES) throw new Error();
    return bytes;
  } catch { throw new Error('ARCHIVE_INTENT_INVALID'); }
}

export function parseArchiveIntent(bytes: Buffer): ArchiveIntent {
  try {
    if (bytes.length > MAX_INTENT_BYTES) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    const envelope = z.strictObject({ payload: z.unknown(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).parse(value);
    if (JSON.stringify(value) !== text || sha256Bytes(Buffer.from(JSON.stringify(envelope.payload))) !== envelope.sha256) throw new Error();
    return validateIntent(envelope.payload);
  } catch { throw new Error('ARCHIVE_INTENT_INVALID'); }
}

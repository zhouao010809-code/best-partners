import { describe, expect, it } from 'vitest';
import { prepareArchiveMove, executeArchiveMove, recoverArchiveMove } from '../../src/server/archive/archive-coordinator.js';

const id = 'e52917bc-a9df-482f-aae8-8c4b6da4301d';
const secondId = 'f6c6d077-3e78-42eb-84cf-4cc018bc7cc9';
const source = '01图书馆/小兆clipper/package';
const target = '01图书馆/来自个人/2026-09/package';
function memoryPort() {
  type Node = { ino: string; kind: 'file' | 'directory'; bytes: Buffer };
  const nodes = new Map<string, Node>();
  for (const [path, ino] of [[source.slice(0, source.lastIndexOf('/')), '2'], [target.slice(0, target.lastIndexOf('/')), '3'], [source, '4']]) {
    nodes.set(path!, { ino: ino!, kind: 'directory', bytes: Buffer.alloc(0) });
  }
  nodes.set(`${source}/main.md`, { ino: '5', kind: 'file', bytes: Buffer.from('原文\r\n') });
  const journal = new Map<string, Buffer>();
  return {
    root: '/test', rootIdentity: { dev: '1', ino: '1' }, nodes, journal,
    stat(path: string) { const n = nodes.get(path); return n ? { dev: '1', ino: n.ino, kind: n.kind, size: n.bytes.length } : null; },
    list(path: string) { return [...nodes].filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
      .map(([p, n]) => ({ name: p.slice(path.length + 1), kind: n.kind })); },
    read(path: string) { return Buffer.from(nodes.get(path)!.bytes); },
    move(from: string, to: string) {
      if (nodes.has(to)) throw new Error('TARGET_EXISTS');
      for (const [path, node] of [...nodes]) if (path === from || path.startsWith(`${from}/`)) {
        nodes.set(to + path.slice(from.length), node); nodes.delete(path);
      }
    },
    syncParents() {}, close() {},
    readRecovery(name: string) { return journal.has(name) ? Buffer.from(journal.get(name)!) : null; },
    writeRecovery(name: string, bytes: Buffer) { if (journal.has(name)) throw new Error('TARGET_EXISTS'); journal.set(name, Buffer.from(bytes)); },
    listRecovery() { return [...journal.keys()].sort(); }
  };
}

describe('archive coordination and restart reconstruction', () => {
  it('persists a self-contained before-image before moving, then records and rechecks the result', () => {
    const port = memoryPort();
    const originalMove = port.move;
    port.move = (from, to) => {
      const saved = JSON.parse(port.journal.get(`${id}.intent.json`)!.toString());
      expect(saved.payload.tree[1].bytesBase64).toBe(Buffer.from('原文\r\n').toString('base64'));
      originalMove(from, to);
    };
    prepareArchiveMove(port, { id, source, target });
    expect(executeArchiveMove(port, id)).toMatchObject({ state: 'moved' });
    expect(port.nodes.has(source)).toBe(false);
    expect(port.nodes.get(`${target}/main.md`)!.bytes.toString()).toBe('原文\r\n');
    expect(executeArchiveMove(port, id)).toMatchObject({ state: 'moved' });
    expect(port.journal.size).toBe(2);
  });

  it('reconstructs unchanged source-only without automatically moving it', () => {
    const port = memoryPort(); prepareArchiveMove(port, { id, source, target });
    expect(recoverArchiveMove(port, id)).toMatchObject({ state: 'not-moved' });
    expect(port.nodes.has(source)).toBe(true); expect(port.journal.size).toBe(1);
  });

  it('reconstructs target-only after interruption without needing SQLite', () => {
    const port = memoryPort(); prepareArchiveMove(port, { id, source, target }); port.move(source, target);
    expect(recoverArchiveMove(port, id)).toMatchObject({ state: 'moved' });
    expect(port.journal.has(`${id}.result.json`)).toBe(true);
  });

  it('refuses changed requests under one ID and new work while an intent is unresolved', () => {
    const port = memoryPort(); prepareArchiveMove(port, { id, source, target });
    expect(() => prepareArchiveMove(port, { id, source, target: `${target}2` })).toThrow('ARCHIVE_REQUEST_CONFLICT');
    expect(() => prepareArchiveMove(port, { id: secondId, source, target })).toThrow('ARCHIVE_RECOVERY_REQUIRED');
  });

  it('refuses a collision without writing intent or touching either tree', () => {
    const port = memoryPort(); port.nodes.set(target, { ino: '6', kind: 'directory', bytes: Buffer.alloc(0) });
    expect(() => prepareArchiveMove(port, { id, source, target })).toThrow('ARCHIVE_TARGET_EXISTS');
    expect(port.nodes.has(source)).toBe(true); expect(port.nodes.get(target)!.ino).toBe('6'); expect(port.journal.size).toBe(0);
  });

  it.each(['both', 'neither', 'changed-file', 'changed-parent', 'changed-root', 'bad-intent', 'bad-result'])('retains evidence and reports needs-review for %s', (scenario) => {
    const port = memoryPort(); prepareArchiveMove(port, { id, source, target });
    if (scenario === 'both') port.nodes.set(target, { ino: '99', kind: 'directory', bytes: Buffer.alloc(0) });
    if (scenario === 'neither') port.nodes.delete(source);
    if (scenario === 'changed-file') port.nodes.get(`${source}/main.md`)!.bytes = Buffer.from('新版本');
    if (scenario === 'changed-parent') port.nodes.get(source.slice(0, source.lastIndexOf('/')))!.ino = '99';
    if (scenario === 'changed-root') port.rootIdentity.ino = '99';
    if (scenario === 'bad-intent') port.journal.set(`${id}.intent.json`, Buffer.from('{'));
    if (scenario === 'bad-result') port.journal.set(`${id}.result.json`, Buffer.from('{}'));
    const before = structuredClone([...port.nodes]);
    expect(executeArchiveMove(port, id)).toMatchObject({ state: 'needs-review' });
    expect(recoverArchiveMove(port, id)).toMatchObject({ state: 'needs-review' });
    expect([...port.nodes]).toEqual(before.map(([path, n]) => [path, { ...n, bytes: Buffer.from(n.bytes) }]));
  });

  it('checks actual target bytes even after a durable success receipt', () => {
    const port = memoryPort(); prepareArchiveMove(port, { id, source, target }); executeArchiveMove(port, id);
    port.nodes.get(`${target}/main.md`)!.bytes = Buffer.from('外部改动');
    expect(recoverArchiveMove(port, id)).toMatchObject({ state: 'needs-review' });
  });

  it('requires the exact receipt to remain readable after result persistence', () => {
    const port = memoryPort(); prepareArchiveMove(port, { id, source, target });
    const write = port.writeRecovery;
    port.writeRecovery = (name, bytes) => { write(name, bytes); if (name.endsWith('.result.json')) port.journal.delete(name); };
    expect(executeArchiveMove(port, id)).toMatchObject({ state: 'needs-review', reason: 'ARCHIVE_RESULT_NOT_DURABLE' });
    expect(port.nodes.has(target)).toBe(true);
  });

  it('preserves a racing replacement moved by the OS and never rolls it back', () => {
    const port = memoryPort(); prepareArchiveMove(port, { id, source, target });
    const originalMove = port.move;
    port.move = (a, b) => { port.nodes.get(source)!.ino = '90'; originalMove(a, b); };
    expect(executeArchiveMove(port, id)).toMatchObject({ state: 'needs-review' });
    expect(port.nodes.get(target)!.ino).toBe('90'); expect(port.nodes.has(source)).toBe(false);
    expect(port.journal.has(`${id}.result.json`)).toBe(false);
  });

  it('does not move when intent persistence is incomplete and does not claim success when syncing fails', () => {
    const broken = memoryPort(); broken.writeRecovery = () => { throw new Error('IO_ERROR'); };
    expect(() => prepareArchiveMove(broken, { id, source, target })).toThrow('IO_ERROR');
    expect(broken.nodes.has(source)).toBe(true);
    const port = memoryPort(); prepareArchiveMove(port, { id, source, target });
    port.syncParents = () => { throw new Error('IO_ERROR'); };
    expect(executeArchiveMove(port, id)).toMatchObject({ state: 'needs-review' });
    expect(port.nodes.has(target)).toBe(true); expect(port.journal.has(`${id}.result.json`)).toBe(false);
  });
});

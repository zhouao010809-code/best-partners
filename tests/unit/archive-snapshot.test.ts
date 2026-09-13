import { describe, expect, it } from 'vitest';
import { captureArchiveTree, parseArchiveIntent, sealArchiveIntent } from '../../src/server/archive/archive-snapshot.js';

const identity = { dev: '1', ino: '2' };
function treePort() {
  const nodes = new Map([
    ['package', { kind: 'directory' as const, ino: '10', bytes: Buffer.alloc(0) }],
    ['package/.hidden', { kind: 'file' as const, ino: '11', bytes: Buffer.from([0, 255, 13, 10]) }],
    ['package/empty', { kind: 'directory' as const, ino: '12', bytes: Buffer.alloc(0) }],
    ['package/main.md', { kind: 'file' as const, ino: '13', bytes: Buffer.from('\uFEFF原文\r\n') }]
  ]);
  return {
    stat: (path: string) => { const node = nodes.get(path); return node ? { dev: '1', ino: node.ino, kind: node.kind, size: node.bytes.length } : null; },
    list: (path: string) => [...nodes].filter(([name]) => name.startsWith(`${path}/`) && !name.slice(path.length + 1).includes('/'))
      .map(([name, node]) => ({ name: name.slice(path.length + 1), kind: node.kind })).reverse(),
    read: (path: string) => Buffer.from(nodes.get(path)!.bytes),
    nodes
  };
}

function intent() {
  return {
    version: 1 as const, id: 'f6c6d077-3e78-42eb-84cf-4cc018bc7cc9', root: identity,
    source: '01图书馆/小兆clipper/package', target: '01图书馆/来自个人/2026-09/package',
    sourceParent: identity, targetParent: { dev: '1', ino: '3' },
    tree: captureArchiveTree(treePort(), 'package')
  };
}

describe('archive snapshot and immutable intent', () => {
  it('captures sorted complete before-images including binary, hidden and empty directory entries', () => {
    const snapshot = captureArchiveTree(treePort(), 'package');
    expect(snapshot.map((entry) => entry.path)).toEqual(['', '.hidden', 'empty', 'main.md']);
    expect(snapshot[1]).toMatchObject({ kind: 'file', bytesBase64: 'AP8NCg==', ino: '11' });
    expect(snapshot[2]).toMatchObject({ kind: 'directory', ino: '12' });
    expect(snapshot[3]).toMatchObject({ bytesBase64: Buffer.from('\uFEFF原文\r\n').toString('base64') });
  });

  it('rejects a file replaced while its bytes are read', () => {
    const port = treePort();
    const original = port.read;
    port.read = (path) => { const bytes = original(path); port.nodes.get(path)!.ino = '90'; return bytes; };
    expect(() => captureArchiveTree(port, 'package')).toThrow('ARCHIVE_TREE_CHANGED');
  });

  it('rejects changed directory membership on the verification scan', () => {
    const port = treePort();
    const original = port.list;
    let calls = 0;
    port.list = (path) => { const list = original(path); if (path === 'package' && ++calls > 1) return list.slice(1); return list; };
    expect(() => captureArchiveTree(port, 'package')).toThrow('ARCHIVE_TREE_CHANGED');
  });

  it('rejects invalid child names and excessive bytes before retaining a snapshot', () => {
    const invalid = treePort();
    invalid.list = () => [{ name: '../escape', kind: 'file' }];
    expect(() => captureArchiveTree(invalid, 'package')).toThrow('ARCHIVE_PATH_INVALID');
    const oversized = treePort();
    oversized.nodes.get('package/main.md')!.bytes = Buffer.alloc(17 * 1024 * 1024);
    expect(() => captureArchiveTree(oversized, 'package')).toThrow('ARCHIVE_TREE_TOO_LARGE');
  });

  it('seals and restores exact before-images while rejecting any checksum divergence', () => {
    const original = intent();
    const bytes = sealArchiveIntent(original);
    expect(parseArchiveIntent(bytes)).toEqual(original);
    const tampered = Buffer.from(bytes.toString().replace('package', 'changed'));
    expect(() => parseArchiveIntent(tampered)).toThrow('ARCHIVE_INTENT_INVALID');
    expect(() => parseArchiveIntent(bytes.subarray(0, bytes.length - 2))).toThrow('ARCHIVE_INTENT_INVALID');
  });

  it.each([
    { source: '02知识库/a/b' }, { target: '01图书馆/来自公开/2026-09/package' },
    { target: '01图书馆/来自个人/2026-13/package' }, { id: '../escape' },
    { id: 'f6c6d077-3e78-72eb-84cf-4cc018bc7cc9' }, { extra: true }
  ])('rejects invalid or extra intent fields before writing a journal: %s', (change) => {
    expect(() => sealArchiveIntent({ ...intent(), ...change })).toThrow('ARCHIVE_INTENT_INVALID');
  });

  it('rejects a noncanonical BOM prefix on a sealed journal', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), sealArchiveIntent(intent())]);
    expect(() => parseArchiveIntent(bytes)).toThrow('ARCHIVE_INTENT_INVALID');
  });

  it('rejects oversized path metadata before an unreadable intent can be persisted', () => {
    const value = intent();
    value.tree = [{ path: '', dev: '1', ino: '2', kind: 'directory' }];
    let path = '';
    for (let depth = 0; depth < 14; depth++) {
      path = path ? `${path}/${'d'.repeat(250)}` : 'd'.repeat(250);
      value.tree.push({ path, dev: '1', ino: String(depth + 3), kind: 'directory' });
    }
    for (let index = 0; index < 9985; index++) value.tree.push({
      path: `${path}/x${String(index).padStart(5, '0')}`, dev: '1', ino: String(index + 20), kind: 'file', bytesBase64: ''
    });
    expect(() => sealArchiveIntent(value)).toThrow('ARCHIVE_INTENT_INVALID');
  });

  it('rejects noncanonical base64, duplicated entries, absent ancestors and a forged directory root', () => {
    for (const change of [
      (value: ReturnType<typeof intent>) => { (value.tree[1] as any).bytesBase64 = '???'; },
      (value: ReturnType<typeof intent>) => { value.tree.push(value.tree[1]!); },
      (value: ReturnType<typeof intent>) => { value.tree[1]!.path = 'missing/file'; },
      (value: ReturnType<typeof intent>) => { value.tree.shift(); }
    ]) {
      const value = structuredClone(intent()); change(value);
      expect(() => sealArchiveIntent(value)).toThrow('ARCHIVE_INTENT_INVALID');
    }
  });
});

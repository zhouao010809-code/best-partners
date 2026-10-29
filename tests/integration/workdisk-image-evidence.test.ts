import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createImageEvidenceReader } from '../../src/server/workdisk/image-evidence.js';
import { createWorkdiskContentNamer } from '../../src/server/workdisk/content-namer.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';

const execute = promisify(execFile);
const helperPath = resolve('dist/native/image-evidence-helper');
let root: string;
let fixturePath: string;
const adapter = (run: AssistantAdapter['run']): AssistantAdapter => ({ id: 'test', describe: async () => ({ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'test', name: 'Test', reasoningEfforts: [] }] }), run });
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'image-evidence-test-'));
  fixturePath = join(root, 'image-fixture');
  if (process.platform === 'darwin') await execute('xcrun', ['swiftc', resolve('tests/native/fixtures/image-evidence-fixture.swift'), '-o', fixturePath]);
}, 30000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function image(kind = 'text', type = 'public.png') { return (await execute(fixturePath, [kind, type], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 })).stdout; }
async function fakeHelper(body: string) {
  const path = join(root, `helper-${Math.random().toString(16).slice(2)}`);
  await writeFile(path, `#!${process.execPath}\n${body}`); await chmod(path, 0o700); return path;
}

describe.skipIf(process.platform !== 'darwin')('local image evidence', () => {
  it('recognizes real synthetic Chinese/English pixels and passes text, never filename or image bytes, to the model', async () => {
    const bytes = await image();
    const evidence = await createImageEvidenceReader({ helperPath })(bytes);
    expect(evidence.status).toBe('ready'); expect(evidence.text).toContain('短视频'); expect(evidence.text).toContain('Audience research');
    let request: AssistantRunInput | undefined;
    const result = await createWorkdiskContentNamer({ imageHelperPath: helperPath, adapter: adapter(async input => {
      request = input; input.emit({ type: 'text', text: '{"title":"短视频选题与咨询转化方法.png"}' });
    }) })({ name: '/private/location/a36bf023.png', bytes });
    expect(result.title).toBe('短视频选题与咨询转化方法'); expect(result.reason).toContain('本机识别');
    expect(request!.tools).toEqual([]); expect(request!.messages[0]!.content).toContain('短视频');
    expect(JSON.stringify(request!.messages)).not.toMatch(/private|a36bf023|base64/u);
    expect(JSON.stringify(result)).not.toContain('Audience');
  }, 30000);
  it('reads JPEG, TIFF, BMP and HEIC via actual ImageIO decoders', async () => {
    for (const type of ['public.jpeg', 'public.tiff', 'com.microsoft.bmp', 'public.heic']) {
      const result = await createImageEvidenceReader({ helperPath })(await image('text', type));
      expect(result.status, type).toBe('ready'); expect(result.text, type).toContain('短视频');
    }
  }, 60000);
  it('decodes a minimal WebP without inventing evidence from a one-pixel image', async () => {
    const bytes = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
    const result = await createImageEvidenceReader({ helperPath })(bytes);
    expect(result.status).toBe('ready'); expect(result.text).toBe(''); expect(result.labels).toEqual([]);
  });
  it('keeps blank, malformed and oversized images without a naming request', async () => {
    const run = vi.fn(); const namer = createWorkdiskContentNamer({ imageHelperPath: helperPath, adapter: adapter(run) });
    const blank = await namer({ name: 'blank.png', bytes: await image('blank') });
    expect(blank.title).toBeUndefined(); expect(blank.reason).toContain('保留原名');
    const broken = await namer({ name: 'broken.jpg', bytes: Buffer.from('private invalid pixels') });
    expect(broken.title).toBeUndefined(); expect(broken.reason).toContain('无法读取');
    const huge = await namer({ name: 'huge.png', bytes: Buffer.alloc(20 * 1024 * 1024 + 1) });
    expect(huge.reason).toContain('20 MiB'); expect(run).not.toHaveBeenCalled();
  }, 30000);
});

describe('image evidence process boundary', () => {
  it('rejects malformed or excessive helper output without returning its contents', async () => {
    for (const body of ["process.stdout.write('private invalid output')", "process.stdout.write('x'.repeat(300000))", "process.stderr.write('private'); process.exit(1)"]) {
      const read = createImageEvidenceReader({ helperPath: await fakeHelper(body) });
      await expect(read(Buffer.from('input'))).rejects.toThrow(/^IMAGE_/u);
    }
    await expect(createImageEvidenceReader({ helperPath: join(root, 'missing') })(Buffer.from('input'))).rejects.toThrow('IMAGE_HELPER_UNAVAILABLE');
    expect(() => createImageEvidenceReader({ helperPath: '../unsafe' })).toThrow('IMAGE_HELPER_PATH_INVALID');
  });
  it('terminates a hanging helper on timeout or caller cancellation', async () => {
    const path = await fakeHelper('process.stdin.resume(); setInterval(() => {}, 1000)');
    await expect(createImageEvidenceReader({ helperPath: path, timeoutMs: 25 })(Buffer.from('input'))).rejects.toThrow('IMAGE_RECOGNITION_TIMEOUT');
    const controller = new AbortController();
    const pending = createImageEvidenceReader({ helperPath: path })(Buffer.from('input'), controller.signal);
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('uses only confident useful visual evidence and marks partial recognition', async () => {
    let request: AssistantRunInput | undefined;
    const namer = createWorkdiskContentNamer({ imageEvidenceReader: async () => ({ status: 'ready', text: '', sampled: true, labels: [{ label: 'bicycle', confidence: 0.95 }, { label: 'beach', confidence: 0.2 }] }),
      adapter: adapter(async input => { request = input; input.emit({ type: 'text', text: '{"title":"自行车照片"}' }); }) });
    const result = await namer({ name: '123.webp', bytes: Buffer.from('not sent to model') });
    expect(result.title).toBe('自行车照片'); expect(result.reason).toContain('部分');
    expect(request!.messages[0]!.content).toContain('bicycle'); expect(request!.messages[0]!.content).not.toContain('beach');
    expect(request!.system).toContain('不要猜测人的姓名');
  });
  it('keeps unsupported recognition, vague names and identity-only labels', async () => {
    const run = vi.fn();
    const source = { name: 'aaa.jpeg', bytes: Buffer.from('image') };
    expect((await createWorkdiskContentNamer({ adapter: adapter(run) })(source)).reason).toContain('组件');
    const namer = createWorkdiskContentNamer({ adapter: adapter(run), imageEvidenceReader: async () => ({ status: 'ready', text: '', labels: [{ label: 'person', confidence: 0.99 }], sampled: false }) });
    expect((await namer(source)).reason).toContain('足够明确'); expect(run).not.toHaveBeenCalled();
    for (const title of ['图片', '照片', '截图', 'image']) {
      const vague = createWorkdiskContentNamer({ adapter: adapter(async input => { input.emit({ type: 'text', text: JSON.stringify({ title }) }); }),
        imageEvidenceReader: async () => ({ status: 'ready', text: '短视频选题与咨询转化方法', labels: [], sampled: false }) });
      expect((await vague(source)).title).toBeUndefined();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { parseFrontmatter } from '../../src/server/rules/frontmatter.js';
import { parseLibraryNote } from '../../src/server/rules/library-schema.js';
import { inferIntakeFields, planIntakeMain } from '../../src/server/archive/intake-plan.js';

const fields = { platform: '个人', title: '一份原始资料', collectedAt: '2026-09-05' };
const request = (bytes: Buffer, overrides = {}) => ({ packageName: '原资料包', mainName: '原文.md', bytes, fields, ...overrides });
const note = (header: string, body = '原始正文\n') => Buffer.from(`---\n${header}\n---\n${body}`);
const canonical = `类型: 原始资料
处理状态: 未归档
来源平台: 个人
原始标题: 旧标题
作者: "@原作者"
原始链接: https://example.com/original
采集日期: 2026-09-01
所属主题: ["[[已有主题]]"]
关键词: [保留关键词]
知识入库状态: 未提炼
生成知识: []
备注: "原始说明: 保留"`;

describe('pure intake metadata planner', () => {
  it('creates all canonical fields without changing a document body or inventing optional facts', () => {
    const bytes = Buffer.from('# 原始标题\n\n![图](附件/原图.png)\n<script>不执行</script>');
    const original = Buffer.from(bytes);
    const plan = planIntakeMain(request(bytes));
    expect(plan).toMatchObject({ platform: '个人', month: '2026-09', packageName: '20260905｜个人｜一份原始资料',
      mainName: '20260905｜个人｜一份原始资料.md', sourceMainName: '原文.md' });
    const parsed = parseFrontmatter(plan.bytes);
    expect(Buffer.from(parsed.bodyBytes)).toEqual(original);
    expect(parsed.data).toEqual({ 类型: '原始资料', 处理状态: '已归档', 来源平台: '个人', 原始标题: fields.title,
      作者: null, 原始链接: null, 采集日期: fields.collectedAt, 所属主题: [], 关键词: [],
      知识入库状态: '未提炼', 生成知识: [], 备注: null });
    expect(parseLibraryNote(plan.bytes).record).toMatchObject({ processingStatus: '已归档', knowledgeStatus: '未提炼' });
    expect(bytes).toEqual(original);
  });

  it('preserves BOM, CRLF and exact body bytes when replacing existing frontmatter', () => {
    const body = '第一行\r\n\r\n![图](附件/a.png)\r\n尾行';
    const bytes = Buffer.from(`\uFEFF---\r\n${canonical.replaceAll('\n', '\r\n')}\r\n---\r\n${body}`);
    const original = Buffer.from(bytes);
    const plan = planIntakeMain(request(bytes));
    expect(plan.bytes.subarray(0, 3)).toEqual(Buffer.from('\uFEFF'));
    const parsed = parseFrontmatter(plan.bytes);
    expect(Buffer.from(parsed.bodyBytes)).toEqual(Buffer.from(body));
    const header = plan.bytes.subarray(3, plan.bytes.length - parsed.bodyBytes.length).toString();
    expect(header.replaceAll('\r\n', '')).not.toContain('\n');
    expect(parsed.data).toMatchObject({ 作者: '@原作者', 原始链接: 'https://example.com/original',
      所属主题: ['[[已有主题]]'], 关键词: ['保留关键词'], 备注: '原始说明: 保留' });
    expect(bytes).toEqual(original);
  });

  it('keeps the BOM at the file beginning when adding frontmatter to a bare document', () => {
    const bytes = Buffer.from('\uFEFF原文\r\n末尾');
    const plan = planIntakeMain(request(bytes));
    expect(plan.bytes.subarray(0, 3)).toEqual(Buffer.from('\uFEFF'));
    expect(Buffer.from(parseFrontmatter(plan.bytes).bodyBytes)).toEqual(bytes.subarray(3));
  });

  it('prefers existing authors and links over submitted replacements', () => {
    const plan = planIntakeMain(request(note(canonical), { fields: { ...fields, author: '其他作者', url: 'https://example.net/new' } }));
    expect(parseFrontmatter(plan.bytes).data).toMatchObject({ 作者: '@原作者', 原始链接: 'https://example.com/original' });
  });

  it('normalizes recognized plugin metadata and safely quotes colon and at-sign scalar values', () => {
    const bytes = note('title: "原始标题: 一份资料"\nauthor: "@writer"\nsource: https://www.bilibili.com/video/123\ndate: 2026-09-04');
    expect(inferIntakeFields('index.md', bytes)).toEqual({ title: '原始标题: 一份资料', author: '@writer',
      url: 'https://www.bilibili.com/video/123', platform: 'B站', collectedAt: '2026-09-04' });
    const plan = planIntakeMain(request(bytes, { fields: { platform: 'B站', title: '原始标题: 一份资料', collectedAt: '2026-09-04' } }));
    expect(parseFrontmatter(plan.bytes).data).toMatchObject({ 原始标题: '原始标题: 一份资料', 作者: '@writer', 原始链接: 'https://www.bilibili.com/video/123' });
    expect(parseLibraryNote(plan.bytes).record).toBeDefined();
    expect(Buffer.from(parseFrontmatter(plan.bytes).bodyBytes)).toEqual(Buffer.from('原始正文\n'));
  });

  it('infers canonical fields without replacing explicit platform data with a domain guess', () => {
    expect(inferIntakeFields('原文.md', note(canonical))).toEqual({ platform: '个人', title: '旧标题',
      author: '@原作者', url: 'https://example.com/original', collectedAt: '2026-09-01' });
  });

  it('reads the plugin clipped date without confusing it with the publication timestamp', () => {
    expect(inferIntakeFields('原文.md', note('clipped: 2026-09-05\npublished: "2026-09-04T21:44:40.000Z"')))
      .toEqual({ collectedAt: '2026-09-05' });
    expect(inferIntakeFields('原文.md', note('published: 2026-09-04'))).toEqual({});
  });

  it.each(['2026-02-30', '20260905', '2026-09-05T12:00:00Z'])('does not infer an unsupported clipped date: %s', (date) => {
    expect(inferIntakeFields('原文.md', note(`clipped: "${date}"`))).toEqual({});
  });

  it('preserves plugin information before the unchanged original body and produces valid canonical metadata', () => {
    const extra = { published: '2026-09-04T21:44:40.000Z', description: '原始描述: 保留', 学习状态: '未学习' };
    const body = '\r\n# 原文\r\n![图](附件/a.png)\r\n<script>不执行</script>\r\n尾行';
    const bytes = Buffer.from(`\uFEFF---\r\n${stringify({ title: '真实插件样式', author: '@writer', source: 'https://x.com/writer/status/1', clipped: '2026-09-05', ...extra }).replaceAll('\n', '\r\n')}---\r\n${body}`);
    const before = Buffer.from(bytes);
    const inferred = inferIntakeFields('原文.md', bytes);
    const plan = planIntakeMain(request(bytes, { fields: inferred }));
    const parsed = parseFrontmatter(plan.bytes);
    expect(parsed.data).toMatchObject({ 来源平台: 'X推特', 作者: '@writer', 采集日期: '2026-09-05', 知识入库状态: '未提炼' });
    expect(parsed.data).not.toHaveProperty('published');
    expect(plan.bytes.subarray(0, 3)).toEqual(Buffer.from('\uFEFF'));
    const newBody = Buffer.from(parsed.bodyBytes);
    expect(newBody.subarray(-Buffer.byteLength(body))).toEqual(Buffer.from(body));
    const prefix = newBody.subarray(0, newBody.length - Buffer.byteLength(body)).toString();
    expect(prefix).toMatch(/^## 原始资料信息\r\n\r\n```yaml\r\n/u);
    expect(parse(prefix.split('```yaml\r\n')[1]!.split('```')[0]!)).toEqual(extra);
    expect(prefix.replaceAll('\r\n', '')).not.toContain('\n');
    expect(parseLibraryNote(plan.bytes).record).toBeDefined();
    expect(planIntakeMain(request(plan.bytes, { fields: inferred })).bytes).toEqual(plan.bytes);
    expect(bytes).toEqual(before);
  });

  it('does not duplicate an identical existing information block', () => {
    const first = planIntakeMain(request(note('description: 原有说明')));
    const body = Buffer.from(parseFrontmatter(first.bytes).bodyBytes).toString();
    const second = planIntakeMain(request(note('description: 原有说明', body)));
    expect(Buffer.from(parseFrontmatter(second.bytes).bodyBytes).toString()).toBe(body);
  });

  it('recognizes already preserved values despite YAML quoting differences', () => {
    const body = '## 原始资料信息\n\n```yaml\ndescription: 原有说明\n```\n\n原文\n';
    const plan = planIntakeMain(request(note('description: 原有说明', body)));
    expect(Buffer.from(parseFrontmatter(plan.bytes).bodyBytes).toString()).toBe(body);
  });

  it('adds only missing fields when the existing information block is partial', () => {
    const body = '## 原始资料信息\n\n```yaml\ndescription: "原有说明"\n```\n\n原文\n';
    const plan = planIntakeMain(request(note('description: 原有说明\npublished: 2026-09-04', body)));
    const result = Buffer.from(parseFrontmatter(plan.bytes).bodyBytes).toString();
    expect(result.match(/description:/gu)).toHaveLength(1);
    expect(result).toContain('published: "2026-09-04"');
    expect(result.endsWith(body)).toBe(true);
  });

  it('does not discard metadata based on a coincidental body substring or an ambiguous information block', () => {
    const body = '原有说明\n\n## 原始资料信息\n\n```yaml\ndescription: 原有说明\ndescription: 不同信息\n```\n\n原文\n';
    const plan = planIntakeMain(request(note('description: 原有说明', body)));
    const result = Buffer.from(parseFrontmatter(plan.bytes).bodyBytes).toString();
    expect(result.startsWith('## 原始资料信息\n\n```yaml\ndescription: "原有说明"')).toBe(true);
    expect(result.endsWith(body)).toBe(true);
  });

  it('quotes multiline and Markdown-like metadata as literal values', () => {
    const extra = { description: '说明\n```\n<script>alert(1)</script>\n![图](https://example.com/track)\n"引号"', 学习状态: '未学习' };
    const output = planIntakeMain(request(note(stringify(extra))));
    const body = Buffer.from(parseFrontmatter(output.bytes).bodyBytes).toString();
    const block = /^## 原始资料信息\n\n```yaml\n([\s\S]*?)\n```\n\n/u.exec(body);
    expect(block).not.toBeNull();
    expect(parse(block![1]!)).toEqual(extra);
    expect(block![1]!.split('\n').some((line) => line === '```' || line.startsWith('<script>'))).toBe(false);
  });

  it('retains the original clipped value if the confirmed collection date corrects it', () => {
    const plan = planIntakeMain(request(note('clipped: 2026-02-30')));
    expect(parseFrontmatter(plan.bytes).data.采集日期).toBe('2026-09-05');
    expect(Buffer.from(parseFrontmatter(plan.bytes).bodyBytes).toString()).toContain('clipped: "2026-02-30"');
  });

  it('accepts matching date aliases but refuses conflicting ones', () => {
    expect(() => planIntakeMain(request(note('采集日期: 2026-09-05\nclipped: 2026-09-05')))).not.toThrow();
    expect(() => planIntakeMain(request(note('date: 2026-09-04\nclipped: 2026-09-05'))))
      .toThrow(expect.objectContaining({ code: 'INTAKE_METADATA_CONFIRMATION_REQUIRED' }));
  });

  it.each(['description: [保留]', 'published: 42', '学习状态: false', 'description: "\\uD800"', 'description: "\\0"'])
    ('refuses invalid plugin information without silently altering it: %s', (header) => {
      expect(() => planIntakeMain(request(note(header))))
        .toThrow(expect.objectContaining({ code: 'INTAKE_METADATA_CONFIRMATION_REQUIRED' }));
    });

  it('leaves uncertain platforms and dates empty rather than deriving them from the current clock', () => {
    expect(inferIntakeFields('一些资料.md', note('title: 一些资料\nurl: https://unknown.example/article')))
      .toEqual({ title: '一些资料', url: 'https://unknown.example/article' });
    expect(inferIntakeFields('原文.md', Buffer.from('正文'))).toEqual({});
    expect(inferIntakeFields('自拟标题.md', Buffer.from('正文'))).toEqual({ title: '自拟标题' });
  });

  it('uses an existing canonical filename as evidence for fields when metadata is absent', () => {
    expect(inferIntakeFields('20260904｜B站｜标题.md', Buffer.from('正文')))
      .toEqual({ platform: 'B站', title: '标题', collectedAt: '2026-09-04' });
  });

  it('keeps the full original title while limiting the safe filename title to twenty Unicode characters', () => {
    const title = '甲'.repeat(25) + '/附录';
    const plan = planIntakeMain(request(Buffer.from('原文'), { fields: { ...fields, title } }));
    expect(plan.mainName).toBe(`20260905｜个人｜${'甲'.repeat(20)}.md`);
    expect(parseFrontmatter(plan.bytes).data.原始标题).toBe(title);
    const emoji = planIntakeMain(request(Buffer.from('原文'), { fields: { ...fields, title: '😀'.repeat(21) } }));
    expect(emoji.mainName).toBe(`20260905｜个人｜${'😀'.repeat(20)}.md`);
  });

  it.each(['2026-02-30', '2026-13-01', '20260905', '0000-01-01'])('rejects invalid collection dates: %s', (collectedAt) => {
    expect(() => planIntakeMain(request(Buffer.from('正文'), { fields: { ...fields, collectedAt } })))
      .toThrow(expect.objectContaining({ code: 'INTAKE_DATE_INVALID' }));
  });

  it.each([{ packageName: '../escape' }, { mainName: '../原文.md' }, { mainName: '图片.png' },
    { packageName: 'a\\b' }, { mainName: 'a\0.md' }, { packageName: '\ud800' }])('rejects unsafe source names: %s', (change) => {
    expect(() => planIntakeMain(request(Buffer.from('正文'), change))).toThrow(expect.objectContaining({ code: 'INTAKE_PATH_INVALID' }));
  });

  it.each(['', '未知平台'])('requires a confirmed platform: %s', (platform) => {
    expect(() => planIntakeMain(request(Buffer.from('正文'), { fields: { ...fields, platform } })))
      .toThrow(expect.objectContaining({ code: 'INTAKE_PLATFORM_REQUIRED' }));
  });

  it.each(['', ' /\\:*? '])('requires a usable title: %s', (title) => {
    expect(() => planIntakeMain(request(Buffer.from('正文'), { fields: { ...fields, title } })))
      .toThrow(expect.objectContaining({ code: 'INTAKE_TITLE_INVALID' }));
  });

  it.each(['部分入库', '已入库'])('refuses to reset an existing %s knowledge status', (status) => {
    expect(() => planIntakeMain(request(note(canonical.replace('知识入库状态: 未提炼', `知识入库状态: ${status}`)))))
      .toThrow(expect.objectContaining({ code: 'INTAKE_ALREADY_PROCESSED' }));
  });

  it('refuses existing generated knowledge even if its status says unprocessed', () => {
    expect(() => planIntakeMain(request(note(canonical.replace('生成知识: []', '生成知识: ["[[已有知识]]"]')))))
      .toThrow(expect.objectContaining({ code: 'INTAKE_ALREADY_PROCESSED' }));
  });

  it.each(['followers: 12', 'secret: SECRET_VALUE', 'extra: false', 'extra: 0', 'extra: [保留]', 'extra: {键: 值}'])
    ('refuses nonempty unknown metadata without leaking its original value: %s', (extra) => {
      let error: unknown;
      try { planIntakeMain(request(note(`title: 标题\n${extra}`))); } catch (value) { error = value; }
      expect(error).toMatchObject({ code: 'INTAKE_METADATA_CONFIRMATION_REQUIRED' });
      expect((error as Error).message).toContain('确认');
      expect((error as Error).message).not.toContain('SECRET_VALUE');
    });

  it('allows empty unknown fields without manufacturing replacement facts', () => {
    const plan = planIntakeMain(request(note('title: 标题\nempty: null\nblank: ""\nlist: []\nmap: {}')));
    expect(parseFrontmatter(plan.bytes).data).not.toHaveProperty('empty');
    expect(parseFrontmatter(plan.bytes).data.作者).toBeNull();
  });

  it('refuses conflicting recognized aliases instead of discarding one of their facts', () => {
    expect(() => planIntakeMain(request(note('作者: 甲\nauthor: 乙'))))
      .toThrow(expect.objectContaining({ code: 'INTAKE_METADATA_CONFIRMATION_REQUIRED' }));
  });

  it('does not infer a platform from a lookalike hostname', () => {
    expect(inferIntakeFields('原文.md', note('url: https://bilibili.com.example.net/article')))
      .toEqual({ url: 'https://bilibili.com.example.net/article' });
  });

  it.each(['作者: "\\uD800"', '备注: "\\uD800"', '关键词: ["\\uD800"]'])
    ('refuses invalid Unicode metadata instead of silently changing a scalar: %s', (header) => {
      expect(() => planIntakeMain(request(note(header))))
        .toThrow(expect.objectContaining({ code: 'INTAKE_METADATA_CONFIRMATION_REQUIRED' }));
    });

  it('refuses an invalid Unicode author submitted by the caller', () => {
    expect(() => planIntakeMain(request(Buffer.from('正文'), { fields: { ...fields, author: '\ud800' } })))
      .toThrow(expect.objectContaining({ code: 'INTAKE_METADATA_CONFIRMATION_REQUIRED' }));
  });

  it.each([Buffer.from([0xff]), Buffer.concat([note('title: 标题'), Buffer.from([0xff])])])('rejects invalid UTF-8 anywhere in the original file', (bytes) => {
    expect(() => planIntakeMain(request(bytes))).toThrow(expect.objectContaining({ code: 'INTAKE_ENCODING_INVALID' }));
    expect(() => inferIntakeFields('原文.md', bytes)).toThrow(expect.objectContaining({ code: 'INTAKE_ENCODING_INVALID' }));
  });

  it.each(['---\ntitle: 未闭合', '---\nauthor: @bad\n---\n正文', '---\ntitle: 一\ntitle: 二\n---\n正文',
    '---\ntitle: &a 标题\nauthor: *a\n---\n正文'])('rejects malformed or ambiguous frontmatter: %s', (text) => {
    expect(() => planIntakeMain(request(Buffer.from(text)))).toThrow(expect.objectContaining({ code: 'INTAKE_FRONTMATTER_INVALID' }));
  });
});

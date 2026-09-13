import { stringify } from 'yaml';
import { isIsoCalendarDate } from '../../shared/domain/iso-date.js';
import { parseFrontmatter } from '../rules/frontmatter.js';
import { parseLibraryNote, SOURCE_PLATFORMS } from '../rules/library-schema.js';
import { validateArchivePaths } from './archive-snapshot.js';

export type IntakeFields = { platform: string; title: string; collectedAt: string; author?: string | undefined; url?: string | undefined };
type SourcePlatform = typeof SOURCE_PLATFORMS[number];
type InferredIntakeFields = Partial<Omit<IntakeFields, 'platform'>> & { platform?: SourcePlatform };

const MESSAGES = {
  INTAKE_PATH_INVALID: '资料包或主文档名称不安全，请重新确认。',
  INTAKE_ENCODING_INVALID: '主文档不是有效的 UTF-8 文本，原文件未改动。',
  INTAKE_FRONTMATTER_INVALID: '原有资料信息格式不完整或存在歧义，请先确认。',
  INTAKE_METADATA_CONFIRMATION_REQUIRED: '存在尚未确认或无法无损映射的资料信息，请确认后再归档。',
  INTAKE_ALREADY_PROCESSED: '资料已有知识入库记录，不能重新归档并重置状态。',
  INTAKE_PLATFORM_REQUIRED: '请确认资料的来源平台。',
  INTAKE_DATE_INVALID: '请填写有效的采集日期，格式为 YYYY-MM-DD。',
  INTAKE_TITLE_INVALID: '请填写可生成安全文件名的资料标题。'
} as const;

export class IntakePlanError extends Error {
  constructor(public readonly code: keyof typeof MESSAGES) {
    super(MESSAGES[code]);
    this.name = 'IntakePlanError';
  }
}

const CANONICAL_KEYS = ['类型', '处理状态', '来源平台', '原始标题', '作者', '原始链接', '采集日期',
  '所属主题', '关键词', '知识入库状态', '生成知识', '备注'];
const PLUGIN_INFO_KEYS = ['published', 'description', '学习状态'];
const PLUGIN_KEYS = ['title', 'author', 'source', 'url', 'date', 'clipped', ...PLUGIN_INFO_KEYS];
const PLATFORMS: readonly string[] = SOURCE_PLATFORMS;

function meaningful(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function validText(value: string): boolean {
  return !value.includes('\0') && Buffer.from(value).toString('utf8') === value;
}

function assertName(value: string, markdown = false): void {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\0]/u.test(value)
    || Buffer.byteLength(value) > 255 || !validText(value) || (markdown && !/\.md$/iu.test(value))) {
    throw new IntakePlanError('INTAKE_PATH_INVALID');
  }
}

function readMain(bytes: Buffer) {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new IntakePlanError('INTAKE_ENCODING_INVALID'); }
  const bom = text.startsWith('\uFEFF');
  const content = bom ? bytes.subarray(3) : bytes;
  const newline = (bom ? text.slice(1) : text).match(/\r?\n/u)?.[0] ?? '\n';
  const first = (bom ? text.slice(1) : text).split(/\r?\n/u, 1)[0]!;
  if (first !== '---') {
    if (first.trim() === '---') throw new IntakePlanError('INTAKE_FRONTMATTER_INVALID');
    return { data: {} as Record<string, unknown>, body: content, bom, newline };
  }
  try {
    const parsed = parseFrontmatter(bytes);
    return { data: parsed.data, body: Buffer.from(parsed.bodyBytes), bom, newline };
  } catch { throw new IntakePlanError('INTAKE_FRONTMATTER_INVALID'); }
}

function scalar(values: readonly unknown[], strict: boolean): string | undefined {
  const present = values.filter(meaningful);
  if (strict && (present.some((value) => typeof value !== 'string') || new Set(present).size > 1)) {
    throw new IntakePlanError('INTAKE_METADATA_CONFIRMATION_REQUIRED');
  }
  return present.find((value): value is string => typeof value === 'string');
}

function platformFromUrl(value: string | undefined): SourcePlatform | undefined {
  if (!value) return;
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol)) return;
  const domains: readonly [SourcePlatform, readonly string[]][] = [
    ['B站', ['bilibili.com', 'b23.tv']], ['YouTube', ['youtube.com', 'youtu.be']],
    ['抖音', ['douyin.com']], ['小红书', ['xiaohongshu.com', 'xhslink.com']],
    ['公众号', ['mp.weixin.qq.com']], ['飞书', ['feishu.cn', 'larksuite.com']],
    ['X推特', ['x.com', 'twitter.com']], ['Reddit', ['reddit.com', 'redd.it']], ['小宇宙', ['xiaoyuzhoufm.com']]
  ];
  return domains.find(([, hosts]) => hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)))?.[0];
}

function mappedFields(data: Record<string, unknown>, strict: boolean): InferredIntakeFields {
  const source = scalar([data.source], strict);
  const sourcePlatform = source !== undefined && PLATFORMS.includes(source) ? source : undefined;
  const sourceUrl = source !== undefined && /^https?:\/\//iu.test(source) ? source : undefined;
  if (strict && source !== undefined && sourcePlatform === undefined && sourceUrl === undefined) {
    throw new IntakePlanError('INTAKE_METADATA_CONFIRMATION_REQUIRED');
  }
  const title = scalar([data.原始标题, data.title], strict);
  const author = scalar([data.作者, data.author], strict);
  const url = scalar([data.原始链接, data.url, sourceUrl], strict);
  const date = scalar([data.采集日期, data.date, data.clipped], strict);
  const explicitPlatform = scalar([data.来源平台, sourcePlatform], strict);
  const platform = SOURCE_PLATFORMS.find((value) => value === explicitPlatform) ?? platformFromUrl(url);
  return {
    ...(title === undefined ? {} : { title }), ...(author === undefined ? {} : { author }),
    ...(url === undefined ? {} : { url }), ...(platform === undefined ? {} : { platform }),
    ...(date === undefined || !validDate(date) ? {} : { collectedAt: date })
  };
}

function validDate(value: string): boolean {
  return /^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/u.test(value) && isIsoCalendarDate(value);
}

export function inferIntakeFields(mainName: string, bytes: Buffer): InferredIntakeFields {
  assertName(mainName, true);
  const { data } = readMain(bytes);
  const title = mainName.slice(0, -3);
  const canonical = /^([1-9][0-9]{3})([0-9]{2})([0-9]{2})｜([^｜]+)｜(.+)$/u.exec(title);
  let fallback: InferredIntakeFields = /^(index|readme|原文|正文)$/iu.test(title) ? {} : { title };
  if (canonical) {
    const date = `${canonical[1]}-${canonical[2]}-${canonical[3]}`;
    const platform = SOURCE_PLATFORMS.find((value) => value === canonical[4]);
    if (validDate(date) && platform !== undefined) {
      fallback = { title: canonical[5]!, platform, collectedAt: date };
    }
  }
  return { ...fallback, ...mappedFields(data, false) };
}

/** The same deterministic body is checked again before archive/recovery writes. */
export function preserveIntakeBody(bytes: Buffer, collectedAt: string): Buffer {
  const original = readMain(bytes);
  const information: Record<string, string> = {};
  for (const key of [...PLUGIN_INFO_KEYS, 'clipped']) {
    const value = original.data[key];
    if (!meaningful(value) || (key === 'clipped' && value === collectedAt)) continue;
    if (typeof value !== 'string' || !validText(value)) {
      throw new IntakePlanError('INTAKE_METADATA_CONFIRMATION_REQUIRED');
    }
    information[key] = value;
  }
  if (!Object.keys(information).length) return original.body;
  // Only an explicitly labelled, unambiguous information block is evidence
  // that a field is already preserved; a matching prose substring is not.
  const blocks = original.body.toString('utf8').matchAll(/^## 原始资料信息\r?\n\r?\n```yaml\r?\n([\s\S]*?)\r?\n```(?=\r?\n|$)/gmu);
  for (const block of blocks) {
    try {
      const retained = parseFrontmatter(Buffer.from(`---\n${block[1]}\n---\n`));
      if (retained.bodyBytes.length) continue;
      for (const [key, value] of Object.entries(information)) {
        if (retained.data[key] === value) delete information[key];
      }
    } catch { /* Keep the original block untouched and preserve missing facts. */ }
  }
  if (!Object.keys(information).length) return original.body;
  // Quoted, JSON-style scalars cannot inject Markdown fences or active HTML.
  const yaml = stringify(information, { lineWidth: 0, defaultKeyType: 'PLAIN', defaultStringType: 'QUOTE_DOUBLE', doubleQuotedAsJSON: true })
    .replaceAll('\n', original.newline);
  const block = Buffer.from(`## 原始资料信息${original.newline}${original.newline}\`\`\`yaml${original.newline}${yaml}\`\`\`${original.newline}${original.newline}`);
  return Buffer.concat([block, original.body]);
}

export function planIntakeMain(input: { packageName: string; mainName: string; bytes: Buffer; fields: IntakeFields }) {
  assertName(input.packageName); assertName(input.mainName, true);
  const original = readMain(input.bytes);
  const data = original.data;
  if (Object.entries(data).some(([key, value]) => !CANONICAL_KEYS.includes(key) && !PLUGIN_KEYS.includes(key) && meaningful(value))) {
    throw new IntakePlanError('INTAKE_METADATA_CONFIRMATION_REQUIRED');
  }
  if ((meaningful(data.类型) && data.类型 !== '原始资料')
    || (meaningful(data.处理状态) && !['未归档', '已归档'].includes(String(data.处理状态)))) {
    throw new IntakePlanError('INTAKE_METADATA_CONFIRMATION_REQUIRED');
  }
  if (['部分入库', '已入库'].includes(String(data.知识入库状态)) || meaningful(data.生成知识)) {
    throw new IntakePlanError('INTAKE_ALREADY_PROCESSED');
  }
  if (meaningful(data.知识入库状态) && data.知识入库状态 !== '未提炼') throw new IntakePlanError('INTAKE_METADATA_CONFIRMATION_REQUIRED');
  const existing = mappedFields(data, true);
  const requestedPlatform = typeof input.fields.platform === 'string' ? input.fields.platform.trim() : '';
  const platform = SOURCE_PLATFORMS.find((value) => value === requestedPlatform);
  if (platform === undefined) throw new IntakePlanError('INTAKE_PLATFORM_REQUIRED');
  const collectedAt = typeof input.fields.collectedAt === 'string' ? input.fields.collectedAt.trim() : '';
  if (!validDate(collectedAt)) throw new IntakePlanError('INTAKE_DATE_INVALID');
  const title = typeof input.fields.title === 'string' ? input.fields.title.trim() : '';
  const shortTitle = Array.from(title.replace(/[<>:"/\\|?*｜\p{Cc}]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 20).join('').trim();
  if (!title || title.length > 1000 || !validText(title) || !shortTitle) throw new IntakePlanError('INTAKE_TITLE_INVALID');
  const packageName = `${collectedAt.replaceAll('-', '')}｜${platform}｜${shortTitle}`;
  const mainName = `${packageName}.md`;
  try { validateArchivePaths(`01图书馆/小兆clipper/${input.packageName}`, `01图书馆/来自${platform}/${collectedAt.slice(0, 7)}/${packageName}`); }
  catch { throw new IntakePlanError('INTAKE_PATH_INVALID'); }
  const metadata = {
    类型: '原始资料', 处理状态: '已归档', 来源平台: platform, 原始标题: title,
    作者: existing.author ?? input.fields.author ?? null, 原始链接: existing.url ?? input.fields.url ?? null,
    采集日期: collectedAt, 所属主题: meaningful(data.所属主题) ? data.所属主题 : [],
    关键词: meaningful(data.关键词) ? data.关键词 : [], 知识入库状态: '未提炼', 生成知识: [],
    备注: meaningful(data.备注) ? data.备注 : null
  };
  if (Object.values(metadata).some((value) => (Array.isArray(value) ? value : [value])
    .some((item) => typeof item === 'string' && !validText(item)))) {
    throw new IntakePlanError('INTAKE_METADATA_CONFIRMATION_REQUIRED');
  }
  const yaml = stringify(metadata, { lineWidth: 0 }).replaceAll('\n', original.newline);
  const bytes = Buffer.concat([Buffer.from(`${original.bom ? '\uFEFF' : ''}---${original.newline}${yaml}---${original.newline}`), preserveIntakeBody(input.bytes, collectedAt)]);
  if (!parseLibraryNote(bytes, mainName).record) throw new IntakePlanError('INTAKE_METADATA_CONFIRMATION_REQUIRED');
  return { platform, month: collectedAt.slice(0, 7), packageName, mainName, bytes, sourceMainName: input.mainName };
}

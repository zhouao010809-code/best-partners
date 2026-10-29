import { z } from 'zod';
import type { WorkdiskAutoState } from '../shared/workdisk-auto.js';

const optionsSchema = z.object({ nameFromContent: z.boolean() }).strict();
const titleSchema = z.string().transform(value => value.normalize('NFKC').trim()).refine(value =>
  value.length > 0 && [...value].length <= 60 && Buffer.byteLength(value) <= 180
  && !/^[.]|[. ]$/u.test(value) && !/[\\/:*?"<>|\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
  && !/\.[a-z0-9]{1,12}$/iu.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(value));
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('输入无效，请检查接收设置或文件名称。');
  return parsed.data;
}
async function safe<T>(action: () => T | Promise<T>, message: string): Promise<T> {
  try { return await action(); } catch { throw new Error(message); }
}

interface WorkdiskAutoService {
  status(): WorkdiskAutoState | Promise<WorkdiskAutoState>;
  configure(path: string, options: { nameFromContent: boolean }): Promise<WorkdiskAutoState>;
  setEnabled(enabled: boolean): Promise<WorkdiskAutoState>;
  setNaming(enabled: boolean): Promise<WorkdiskAutoState>;
  renameReceipt(id: string, title: string): Promise<WorkdiskAutoState>;
  resolveSource(): Promise<string>;
}

export function createDesktopWorkdiskAuto(input: {
  service: WorkdiskAutoService;
  chooseDirectory(options: { nameFromContent: boolean }): Promise<string | undefined>;
  openPath(path: string): Promise<string>;
}) {
  let picking = false;
  return {
    status: () => safe(() => input.service.status(), '无法读取自动接收状态，请重试。'),
    async chooseSource(options: unknown): Promise<WorkdiskAutoState | null> {
      const checked = parse(optionsSchema, options);
      if (picking) throw new Error('请先完成已打开的文件选择窗口。');
      picking = true;
      try {
        const selected = await safe(() => input.chooseDirectory(checked), '无法打开文件选择窗口。');
        if (!selected) return null;
        return await safe(() => input.service.configure(selected, checked), '无法连接这个接收文件夹。请选择独立于工作盘、知识库和应用设置的本地文件夹。');
      } finally { picking = false; }
    },
    async setEnabled(enabled: unknown) {
      const checked = parse(z.boolean(), enabled);
      return safe(() => input.service.setEnabled(checked), '无法更改自动接收状态，请检查工作盘与接收文件夹。');
    },
    async setNaming(enabled: unknown) {
      const checked = parse(z.boolean(), enabled);
      return safe(() => input.service.setNaming(checked), '无法更改自动命名设置，请重试。');
    },
    async renameReceipt(id: unknown, title: unknown) {
      const checkedId = parse(z.uuid(), id); const checkedTitle = parse(titleSchema, title);
      return safe(() => input.service.renameReceipt(checkedId, checkedTitle), '无法修改这个文件的名称，请检查文件是否仍然存在或正在收纳。');
    },
    openSource: () => safe(async () => {
      const path = await input.service.resolveSource();
      if (await input.openPath(path)) throw new Error('OPEN_SOURCE_FAILED');
    }, '无法打开接收文件夹，请重新连接后重试。')
  };
}

import type { FastifyInstance } from 'fastify';
import {
  skillEmptyQuerySchema,
  skillFolderCreateRequestSchema,
  skillFolderResponseSchema,
  skillFolderParamsSchema,
  skillFolderTrashRequestSchema,
  skillFolderTrashPreviewResponseSchema,
  skillFolderTrashEntryResponseSchema,
  skillFolderTrashListResponseSchema,
  skillIdParamsSchema,
  skillMoveRequestSchema,
  skillMoveResponseSchema,
  skillMatchRequestSchema,
  skillsMatchResponseSchema,
  skillResponseSchema,
  skillsResponseSchema
} from '../../../shared/api/skills.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import type { SkillCatalogService } from '../../services/skill-catalog.js';
import type { SkillMatcherService } from '../../services/skill-matcher.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

const folderErrors: Readonly<Record<string, readonly [number, string]>> = {
  SKILL_CATALOG_UNAVAILABLE: [503, '当前 Skill 文件夹暂时不可用，请检查大脑连接后重试。'],
  SKILL_FOLDER_INVALID: [400, '文件夹编号无效，请刷新 Skill 库后重试。'],
  SKILL_FOLDER_NOT_FOUND: [404, '未找到这个自定义文件夹，请刷新。未分类不能回收。'],
  SKILL_LAYOUT_CONFLICT: [409, 'Skill 库有同名 Skill 目录，请先在 Finder 中整理同名目录后重试。'],
  SKILL_FOLDER_TOO_LARGE: [409, '文件夹内容过多，无法完整核验。请先在 Finder 中整理后重试。'],
  SKILL_FOLDER_UNSAFE: [409, '文件夹含符号链接、特殊文件或其他磁盘目录，未移动任何内容。请先在 Finder 中核对。'],
  SKILL_FOLDER_ROOT_CHANGED: [409, '当前 Skill 根目录已变化，未移动文件。请重新打开当前大脑后重试。'],
  SKILL_FOLDER_PREVIEW_STALE: [409, '文件夹已变化或回收预览已过期，请重新预览后再确认。'],
  SKILL_FOLDER_TRASH_UNSAFE: [409, '文件夹回收区或记录已变化，现有内容已保留。请在 Finder 中核对后重试。'],
  SKILL_FOLDER_TRASH_INVALID: [400, '回收记录编号无效，请刷新回收列表后重试。'],
  SKILL_FOLDER_TRASH_NOT_FOUND: [404, '未找到这条回收记录，请刷新回收列表。'],
  SKILL_FOLDER_TRASH_BUSY: [409, '正在处理文件夹，请稍后重试。'],
  SKILL_FOLDER_TRASH_FAILED: [500, '文件夹操作未完成，现有内容已保留。请刷新回收列表核对后重试。'],
  SKILL_FOLDER_RESTORE_CONFLICT: [409, '原位置或当前 Skill 库已有同名内容。请先重命名或移走同名文件夹或 Skill，再恢复；回收内容仍保留。']
};

async function folderOperation<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    // Desktop catalogs cross an independently bundled Electron/server boundary.
    // Reconstruct only known failures; never expose a foreign Error's raw message.
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const safe = typeof code === 'string' && Object.hasOwn(folderErrors, code) ? folderErrors[code] : undefined;
    if (typeof code === 'string' && safe) throw new PublicApiError(code, safe[1], safe[0]);
    throw error;
  }
}

export function registerSkillRoutes(
  app: FastifyInstance,
  service?: SkillCatalogService,
  matcher?: SkillMatcherService
): void {
  const required = (): SkillCatalogService => {
    if (service === undefined) throw new PublicApiError('SKILL_CATALOG_UNAVAILABLE', 'Skill catalog is unavailable.', 503);
    return service;
  };
  const requiredMatcher = (): SkillMatcherService => {
    if (matcher === undefined) throw new PublicApiError('SKILL_CATALOG_UNAVAILABLE', 'Skill catalog is unavailable.', 503);
    return matcher;
  };
  const folderTrash = () => {
    const catalog = required();
    if (!catalog.previewFolderTrash || !catalog.trashFolder || !catalog.listFolderTrash || !catalog.restoreFolder) {
      throw new PublicApiError('SKILL_CATALOG_UNAVAILABLE', '当前连接不提供个人 Skill 文件夹回收。', 503);
    }
    return { preview: catalog.previewFolderTrash, commit: catalog.trashFolder, list: catalog.listFolderTrash, restore: catalog.restoreFolder };
  };

  app.post('/api/v1/skills/folders/:folderId/trash-preview', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { folderId } = parseApiInput(skillFolderParamsSchema, request.params);
    parseApiInput(skillEmptyQuerySchema, request.body);
    return parseApiOutput(skillFolderTrashPreviewResponseSchema, { data: await folderOperation(() => folderTrash().preview(folderId)), version: API_VERSION });
  });
  app.get('/api/v1/skills/folder-trash', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    parseApiInput(skillEmptyQuerySchema, request.query);
    return parseApiOutput(skillFolderTrashListResponseSchema, { data: await folderOperation(() => folderTrash().list()), version: API_VERSION });
  });
  app.post('/api/v1/skills/folder-trash', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(skillFolderTrashRequestSchema, request.body);
    return parseApiOutput(skillFolderTrashEntryResponseSchema, { data: await folderOperation(() => folderTrash().commit(id)), version: API_VERSION });
  });
  app.post('/api/v1/skills/folder-trash/restore', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(skillFolderTrashRequestSchema, request.body);
    return parseApiOutput(skillFolderTrashEntryResponseSchema, { data: await folderOperation(() => folderTrash().restore(id)), version: API_VERSION });
  });

  app.get('/api/v1/skills', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    parseApiInput(skillEmptyQuerySchema, request.query);
    return parseApiOutput(skillsResponseSchema, { data: await required().list(), version: API_VERSION });
  });

  app.get('/api/v1/skills/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(skillIdParamsSchema, request.params);
    return parseApiOutput(skillResponseSchema, { data: await required().get(id), version: API_VERSION });
  });

  app.post('/api/v1/skills/match', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = parseApiInput(skillMatchRequestSchema, request.body);
    return parseApiOutput(skillsMatchResponseSchema, {
      data: { candidates: await requiredMatcher().match(body.message) },
      version: API_VERSION
    });
  });

  app.post('/api/v1/skills/folders', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = parseApiInput(skillFolderCreateRequestSchema, request.body);
    return parseApiOutput(skillFolderResponseSchema, {
      data: await required().createFolder(body.name),
      version: API_VERSION
    });
  });

  app.post('/api/v1/skills/:id/move', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(skillIdParamsSchema, request.params);
    const body = parseApiInput(skillMoveRequestSchema, request.body);
    return parseApiOutput(skillMoveResponseSchema, {
      data: await required().move(id, body.folderId),
      version: API_VERSION
    });
  });
}

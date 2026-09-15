import type { SkillCatalogService } from '../server/services/skill-catalog.js';

const INVALID_SKILL_MESSAGE = '无法在 Finder 中定位这个 Skill，请刷新后重试。';

export function createDesktopSkillNavigation(input: {
  catalog: Pick<SkillCatalogService, 'resolveSource'>;
  shell: { showItemInFolder(path: string): void };
}): { revealSkill(id: unknown): Promise<void> } {
  return {
    async revealSkill(id: unknown): Promise<void> {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) {
        throw new Error(INVALID_SKILL_MESSAGE);
      }
      try {
        const resolvedPath = await input.catalog.resolveSource(id);
        input.shell.showItemInFolder(resolvedPath);
      } catch {
        throw new Error(INVALID_SKILL_MESSAGE);
      }
    }
  };
}

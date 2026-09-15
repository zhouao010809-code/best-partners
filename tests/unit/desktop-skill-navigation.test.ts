import { describe, expect, it, vi } from 'vitest';
import { createDesktopSkillNavigation } from '../../src/electron/skill-navigation.js';

const validId = 'a'.repeat(64);

describe('desktop skill navigation', () => {
  it('resolves a valid opaque id and reveals the exact SKILL.md path once', async () => {
    const resolveSource = vi.fn().mockResolvedValue('/vault/.claude/skills/writer/SKILL.md');
    const showItemInFolder = vi.fn();
    const navigation = createDesktopSkillNavigation({ catalog: { resolveSource }, shell: { showItemInFolder } });

    await expect(navigation.revealSkill(validId)).resolves.toBeUndefined();
    expect(resolveSource).toHaveBeenCalledOnce();
    expect(resolveSource).toHaveBeenCalledWith(validId);
    expect(showItemInFolder).toHaveBeenCalledOnce();
    expect(showItemInFolder).toHaveBeenCalledWith('/vault/.claude/skills/writer/SKILL.md');
  });

  it.each(['../writer', '/tmp/skill', 'A'.repeat(64), 'not-an-id', '', null, 42])(
    'rejects invalid id %j without calling catalog or shell', async (id) => {
      const resolveSource = vi.fn();
      const showItemInFolder = vi.fn();
      const navigation = createDesktopSkillNavigation({ catalog: { resolveSource }, shell: { showItemInFolder } });

      await expect(navigation.revealSkill(id)).rejects.toThrow('无法在 Finder 中定位这个 Skill，请刷新后重试。');
      expect(resolveSource).not.toHaveBeenCalled();
      expect(showItemInFolder).not.toHaveBeenCalled();
    }
  );

  it('normalizes resolver failures without leaking internal paths', async () => {
    const resolveSource = vi.fn().mockRejectedValue(new Error('/private/secret/SKILL.md'));
    const showItemInFolder = vi.fn();
    const navigation = createDesktopSkillNavigation({ catalog: { resolveSource }, shell: { showItemInFolder } });

    await expect(navigation.revealSkill(validId)).rejects.toThrow('无法在 Finder 中定位这个 Skill，请刷新后重试。');
    await expect(navigation.revealSkill(validId)).rejects.not.toThrow('/private/secret');
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('normalizes Finder failures without leaking internal paths', async () => {
    const resolvedPath = '/private/secret/SKILL.md';
    const resolveSource = vi.fn().mockResolvedValue(resolvedPath);
    const showItemInFolder = vi.fn().mockImplementation(() => { throw new Error(resolvedPath); });
    const navigation = createDesktopSkillNavigation({ catalog: { resolveSource }, shell: { showItemInFolder } });

    await expect(navigation.revealSkill(validId)).rejects.toThrow('无法在 Finder 中定位这个 Skill，请刷新后重试。');
    await expect(navigation.revealSkill(validId)).rejects.not.toThrow(resolvedPath);
  });
});

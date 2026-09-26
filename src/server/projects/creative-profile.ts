import type Database from 'better-sqlite3';
import { PublicApiError } from '../../shared/api/errors.js';
import { creativeProfileSaveSchema, projectCreativeProfileSchema, type ProjectCreativeProfile } from '../../shared/api/creative-profile.js';
import type { ProjectCreationService } from '../../shared/api/project-creations.js';

type ProfileRow = { project_id: string; audience: string; goal: string; style: string; facts: string; avoid: string; samples_json: string; revision: number; updated_at: string };
function failure(code: string, message: string, status = 400): never { throw new PublicApiError(code, message, status); }

export function createCreativeProfileOperations(input: {
  database: Database.Database;
  now: () => Date;
  getCreation: ProjectCreationService['get'];
}): Pick<ProjectCreationService, 'getProfile' | 'saveProfile' | 'getProfileContext'> {
  const { database, now, getCreation } = input;
  function getProfile(projectId: string): ProjectCreativeProfile {
    if (!database.prepare('SELECT 1 FROM personal_projects WHERE id=?').get(projectId)) failure('PROJECT_NOT_FOUND', '项目不存在，请重新打开项目。', 404);
    const row = database.prepare('SELECT * FROM personal_project_creative_profiles WHERE project_id=?').get(projectId) as ProfileRow | undefined;
    if (!row) return { projectId, revision: 0, audience: '', goal: '', style: '', facts: '', avoid: '', samples: [] };
    return projectCreativeProfileSchema.parse({ projectId: row.project_id, audience: row.audience, goal: row.goal, style: row.style,
      facts: row.facts, avoid: row.avoid, samples: JSON.parse(row.samples_json), revision: row.revision, updatedAt: row.updated_at });
  }
  return {
    async getProfile(projectId) { return getProfile(projectId); },
    async saveProfile(projectId, raw) {
      const parsed = creativeProfileSaveSchema.safeParse(raw);
      if (!parsed.success) failure('CREATIVE_PROFILE_INVALID', '创作档案内容无效，请检查后重试。');
      const value = parsed.data;
      database.transaction(() => {
        const current = getProfile(projectId);
        if (current.revision !== value.expectedRevision) failure('CREATIVE_PROFILE_REVISION_CONFLICT', '创作档案已有更新，已保留当前编辑。请重新读取后合并。', 409);
        for (const sample of value.samples) {
          const row = database.prepare(`SELECT c.final_version_id FROM personal_project_creations c
            JOIN personal_project_creation_versions v ON v.creation_id=c.id
            WHERE c.project_id=? AND c.id=? AND v.id=? AND c.discarded_at IS NULL`).get(projectId, sample.creationId, sample.versionId) as { final_version_id: string | null } | undefined;
          const alreadySelected = current.samples.some(previous => previous.creationId === sample.creationId && previous.versionId === sample.versionId);
          if (!row || (row.final_version_id !== sample.versionId && !alreadySelected)) failure('CREATIVE_PROFILE_SAMPLE_INVALID', '只能选择当前项目已定稿的样稿，请重新选择。');
        }
        database.prepare(`INSERT INTO personal_project_creative_profiles
          (project_id,audience,goal,style,facts,avoid,samples_json,revision,updated_at) VALUES (?,?,?,?,?,?,?,1,?)
          ON CONFLICT(project_id) DO UPDATE SET audience=excluded.audience,goal=excluded.goal,style=excluded.style,
            facts=excluded.facts,avoid=excluded.avoid,samples_json=excluded.samples_json,
            revision=personal_project_creative_profiles.revision+1,updated_at=excluded.updated_at`)
          .run(projectId, value.audience, value.goal, value.style, value.facts, value.avoid, JSON.stringify(value.samples), now().toISOString());
      }).immediate();
      return getProfile(projectId);
    },
    async getProfileContext(projectId) {
      const profile = getProfile(projectId);
      const samples = await Promise.all(profile.samples.map(async sample => {
        const detail = await getCreation(projectId, sample.creationId);
        if (detail.item.discardedAt) failure('CREATIVE_PROFILE_SAMPLE_INVALID', '已选样稿已丢弃，请重新读取创作档案。', 409);
        const version = detail.versions.find(candidate => candidate.id === sample.versionId);
        if (!version) failure('CREATIVE_PROFILE_SAMPLE_INVALID', '已选样稿无法读取，请重新选择。', 409);
        return version;
      }));
      return { profile, samples };
    }
  };
}

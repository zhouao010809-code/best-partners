// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectImportProposal } from '../../src/client/components/company/ProjectImportProposal.js';
import type { CompanyProjectProposal, CompanyProjectRun } from '../../src/client/components/company/company-api.js';

const SHA = 'b'.repeat(64);
const proposal: CompanyProjectProposal = {
  sourceRoot: 'incoming/教育项目', sourceSha256: SHA, suggestedName: '教育项目', suggestedClientName: '培训机构', suggestedStatus: 'draft',
  fields: { clientName: { value: '培训机构', confidence: 'inferred', evidencePaths: ['背景/项目说明.md'] }, serviceStart: { confidence: 'unknown', evidencePaths: [] }, serviceEnd: { confidence: 'unknown', evidencePaths: ['背景/合同.md'] } },
  selectedSkillIds: ['education-strategy', 'common-review'], entries: [{ relativePath: '背景/项目说明.md', kind: 'file', bytes: 88, sha256: SHA }, { relativePath: '背景', kind: 'directory' }], issues: ['没有找到平台账号清单'],
};
const run: CompanyProjectRun = { id: 'run-proposal', projectId: 'project-proposal', sourceSha256: SHA, state: 'proposed', proposal, operationId: 'op-proposal', createdAt: '2026-09-18T08:00:00.000Z', updatedAt: '2026-09-18T08:30:00.000Z' };

afterEach(() => cleanup());

describe('ProjectImportProposal', () => {
  it('renders source evidence and requires confirmation for unknown fields', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => ({ ok: true as const, value: {} }));
    render(<ProjectImportProposal proposal={proposal} run={run} onConfirm={onConfirm} />);
    expect(screen.getByText('incoming/教育项目')).toBeVisible();
    expect(screen.getByText(/1 个文件 \/ 2 项/u)).toBeVisible();
    expect(screen.getByText('推断 · 背景/项目说明.md')).toBeVisible();
    expect(screen.getAllByText('待确认').length).toBeGreaterThan(0);
    expect(screen.getByText(/有 2 项信息未能确认/u)).toBeVisible();
    expect(screen.getByText('没有找到平台账号清单')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /确认并建立项目/u }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ name: '教育项目', clientName: '培训机构', status: 'draft', sourceSha256: SHA, selectedSkillIds: ['education-strategy', 'common-review'] }));
  });

  it('lets the operator change the suggested name and status before confirming', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => ({ ok: true as const, value: {} }));
    render(<ProjectImportProposal proposal={proposal} run={run} onConfirm={onConfirm} />);
    const name = screen.getByRole('textbox', { name: '建议项目名称' });
    await user.clear(name); await user.type(name, '正式教育服务项目');
    await user.selectOptions(screen.getByRole('combobox', { name: '项目状态' }), 'active');
    await user.click(screen.getByRole('button', { name: /确认并建立项目/u }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ name: '正式教育服务项目', status: 'active' }));
  });
});

# Phase 3 DeepSeek Extraction and Human Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 App 内预览将发送给 DeepSeek 的脱敏内容，生成结构化知识候选，完成阅读提示、编辑、接受或放弃，并可靠保存可供下一阶段分批入库的草稿。

**Architecture:** `ExtractionService` 以材料路径、不可变内容 hash 和当前 raw hash 管理一个活动提炼任务；`AIOrchestrator` 只向一个 OpenAI 兼容端点发送当前材料与少量 YAML 召回卡片。候选 universe、每条 draft version、decision 和 write state 保存在 SQLite；本阶段没有正式 vault mutation，后续正式入库按候选子集读取这些版本。

**Tech Stack:** TypeScript, Fastify, Zod, native `fetch`, DeepSeek OpenAI-compatible API, better-sqlite3, SSE, React, Vitest, Playwright

---

## File Structure

**Create:**

- `src/server/db/migrations/005_extraction_workflow.sql` — 重建 extraction run，并增加 briefing、候选、模型请求和短期事件表。
- `src/shared/domain/workflow.ts` — 阅读状态、run、briefing、candidate decision/write state。
- `src/server/db/repositories/extraction-repository.ts` — 活动任务、候选版本和状态持久化。
- `src/server/events/workflow-event-repository.ts` — 24 小时 SSE 事件；长期记录继续使用现有 `audit_events`。
- `src/server/rules/source-content-identity.ts` — 忽略 App 自己可更新字段后的材料内容身份 hash。
- `src/server/ai/redaction.ts` — 确定性脱敏和证据 block 定位。
- `src/server/ai/compatible-client.ts` — 有界、可取消的 OpenAI 兼容 client。
- `src/server/ai/model-config.ts` — DeepSeek 默认预设、可切换 OpenAI 兼容端点和 secret/config provider 边界。
- `src/server/ai/schemas.ts` — 模型返回的 strict Zod schema。
- `src/server/ai/prompts.ts` — 使用当前规则 bundle 的提炼 prompt。
- `src/server/ai/orchestrator.ts` — 脱敏、调用、校验、全有或全无落草稿。
- `src/server/rules/candidate-validator.ts` — 路径、知识类型、证据和召回字段规则。
- `src/server/workflow/extraction-service.ts` — start/resume/ack/edit/decision 生命周期。
- `src/server/workflow/knowledge-match-service.ts` — 仅使用标题和 YAML 召回字段的去重匹配。
- `src/server/api/routes/extraction-previews.ts`
- `src/server/api/routes/extraction-runs.ts`
- `src/server/api/routes/candidates.ts`
- `src/server/api/routes/workflow-events.ts`
- `src/server/events/sse.ts`
- `src/client/pages/ExtractionWorkbenchPage.tsx`
- `src/client/components/extraction/ReadingStateGate.tsx`
- `src/client/components/extraction/ModelInputPreview.tsx`
- `src/client/components/extraction/MaterialBriefingPanel.tsx`
- `src/client/components/extraction/SourceReader.tsx`
- `src/client/components/extraction/CandidateList.tsx`
- `src/client/components/extraction/CandidateEditor.tsx`
- `src/client/components/extraction/KnowledgeMatches.tsx`
- `src/client/styles/extraction.css`
- `tests/fixtures/fake-openai-server.ts`
- `tests/integration/extraction-repository.test.ts`
- `tests/unit/source-content-identity.test.ts`
- `tests/unit/redaction.test.ts`
- `tests/integration/ai-client.test.ts`
- `tests/unit/model-settings-store.test.ts`
- `tests/unit/electron-preload-model-key.test.ts`
- `tests/unit/electron-preload-model-settings.test.ts`
- `tests/unit/candidate-validator.test.ts`
- `tests/integration/ai-orchestrator.test.ts`
- `tests/integration/extraction-service.test.ts`
- `tests/integration/historical-partial-recovery.test.ts`
- `tests/integration/extraction-api.test.ts`
- `tests/integration/sse-resume.test.ts`
- `tests/component/extraction-workbench.test.tsx`
- `tests/e2e/extraction-draft-flow.spec.ts`

**Modify:**

- `src/server/db/migrate.ts` — 在 migration 004 后注册 005。
- `scripts/copy-server-assets.ts` — 打包 migration 005。
- `src/server/app.ts` — 注入提炼服务并注册路由。
- `src/server/start-server.ts` — 构造模型、仓库、事件和提炼服务。
- `src/shared/api/schemas.ts` — 提炼 API 的严格 schema。
- `src/client/api/client.ts` — 提炼 preview/run/candidate/event 方法。
- `src/client/app/router.tsx` — 用真实工作台替换提炼占位页。
- `src/client/pages/DashboardPage.tsx` — `开始提炼` 入口。
- `src/client/pages/QueuePage.tsx` — `开始提炼`、`继续处理` 和历史恢复入口。
- `src/client/pages/SettingsPage.tsx` — 密钥状态、可切换 OpenAI 兼容端点/模型和连通性结果。
- `src/client/pages/OperationsPage.tsx` — 脱敏后的模型与候选操作事件。
- `src/electron/settings-store.ts` — 增加 `safeStorage` 模型密钥和受校验的非秘密端点/模型设置，不改变通用设置存储职责。
- `src/electron/preload.ts` — 暴露单用途模型密钥与端点设置 IPC，不暴露通用 IPC。
- `src/shared/desktop/bridge.ts` — 扩展同一 `XiaozhaoDesktopApi` 的密钥 status/set/clear 和非秘密 config get/set 能力。

## Cross-Phase Contracts

- Migration 003 属于 Phase 1 write kernel，migration 004 属于自动入馆，本阶段只新增 migration 005。
- `ruleFingerprint` 直接使用 Phase 0 的全局五文件 bundle：`00_ / 01_ / 02_图书馆入馆规则 / 03_ / 05_`；不单独计算模型 prompt 指纹。
- 候选 preview/start/retry 依赖 Phase 0 注入的同一个 `RuleCompatibilityGate` port/record；默认 deny，测试 fixture 可显式批准测试指纹，Phase 6 才实现 Electron production 审批，本阶段不另建实现。当前 bundle 与最后批准指纹不同或没有批准值时返回 `RULE_BUNDLE_UNAPPROVED`；重启、重新扫描或重新生成 preview 都不能自动批准，浏览、搜索和已有草稿审阅仍可用。
- 本阶段不得调用 `WriteCoordinator`；它只产生本地草稿。
- `CandidateDraft.writeState` 从第一天即定义为 `unwritten | planned | committed`，本阶段只能写入 `unwritten`，为 Phase 4 候选子集批次保留一致类型。
- `sourceContentSha256` 忽略且仅忽略 `知识入库状态` 与 `生成知识` 的值；`currentSourceRawSha256` 保存本次打开时完整原始字节 hash。Phase 4 每次成功回写来源后必须推进 current hash，而不能使自己的 run 失效。

### Task 1: Migrate and persist extraction workflow state

**Files:**

- Create: `src/server/db/migrations/005_extraction_workflow.sql`
- Create: `src/shared/domain/workflow.ts`
- Create: `src/server/db/repositories/extraction-repository.ts`
- Create: `src/server/events/workflow-event-repository.ts`
- Modify: `src/server/db/migrate.ts`
- Modify: `scripts/copy-server-assets.ts`
- Test: `tests/integration/extraction-repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Test one active run per material, source-content changes, legal candidate transitions and independent draft versions:

```ts
const run = repository.createOrGetRun({
  materialPath: '01图书馆/来自公众号/2026-09/article/source.md',
  sourceContentSha256: 'a'.repeat(64),
  currentSourceRawSha256: 'b'.repeat(64),
  readingState: '未看',
  ruleFingerprint: 'c'.repeat(64)
});
repository.sealCandidates(run.id, run.version, briefing, candidates);
const accepted = repository.updateCandidate(candidates[0]!.id, 1, {
  draft: candidates[0]!,
  decision: 'accepted'
});
expect(accepted.candidate.version).toBe(2);
expect(accepted.candidate.writeState).toBe('unwritten');
expect(repository.getRun(run.id)?.state).toBe('reviewing');
```

Assert `accepted ↔ abandoned ↔ pending` remains reversible while `writeState=unwritten`, planned/committed candidates reject edits, an identical content identity resumes, a changed content identity invalidates the old run, and a current raw hash can advance only when the content identity remains equal. Sealing a valid empty candidate array yields `reviewing` with zero drafts; `beginZeroCandidateRetry` is legal only for that state/version, returns to `generating`, and never deletes a nonempty candidate universe.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:integration -- extraction-repository
```

Expected: migration and repository modules are absent.

- [ ] **Step 3: Define shared workflow types**

Create `src/shared/domain/workflow.ts`:

```ts
export type ReadingState = '已看' | '未看';
export type CandidateDecision = 'pending' | 'accepted' | 'abandoned';
export type CandidateWriteState = 'unwritten' | 'planned' | 'committed';
export type ExtractionState =
  | 'generating'
  | 'reviewing'
  | 'completed'
  | 'invalidated'
  | 'recovery_required';

export type MaterialBriefing = {
  sentences: string[];
  keyPoints: string[];
  usefulness: string;
  caution?: string;
};

export type CandidateEvidence = {
  blockId: string;
  startInRedactedBlock: number;
  endInRedactedBlock: number;
  excerptHash: string;
};

export type CandidateDraft = {
  id: string;
  runId: string;
  position: number;
  title: string;
  knowledgeType: string;
  suggestedPath: string;
  topics: string[];
  keywords: string[];
  scenarios: string[];
  conclusion: string;
  keyPoints: string[];
  boundary: string;
  bodyMarkdown: string;
  value: string;
  evidence: CandidateEvidence[];
  sourceContribution: string;
  decision: CandidateDecision;
  writeState: CandidateWriteState;
  draftSha256: string;
  version: number;
};
```

- [ ] **Step 4: Rebuild the skeleton table and add workflow tables**

Create migration 005:

```sql
DROP INDEX IF EXISTS one_active_run_per_material_version;
ALTER TABLE extraction_runs RENAME TO extraction_runs_legacy;

CREATE TABLE extraction_runs (
  id TEXT PRIMARY KEY,
  material_path TEXT NOT NULL,
  source_content_sha256 TEXT NOT NULL CHECK (length(source_content_sha256) = 64),
  current_source_raw_sha256 TEXT NOT NULL CHECK (length(current_source_raw_sha256) = 64),
  reading_state TEXT NOT NULL CHECK (reading_state IN ('已看', '未看')),
  state TEXT NOT NULL CHECK (state IN ('generating', 'reviewing', 'completed', 'invalidated', 'recovery_required')),
  candidate_set_hash TEXT,
  rule_fingerprint TEXT NOT NULL CHECK (length(rule_fingerprint) = 64),
  recovery_mode TEXT NOT NULL DEFAULT 'none' CHECK (recovery_mode IN ('none', 'historical_partial')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO extraction_runs (
  id, material_path, source_content_sha256, current_source_raw_sha256,
  reading_state, state, candidate_set_hash, rule_fingerprint, recovery_mode,
  version, created_at, updated_at
)
SELECT id, material_path, source_raw_sha256, source_raw_sha256,
       reading_state,
       CASE WHEN state IN ('completed', 'invalidated') THEN state ELSE 'invalidated' END,
       candidate_set_hash, lower(hex(randomblob(32))), 'none', version, created_at, updated_at
FROM extraction_runs_legacy;

DROP TABLE extraction_runs_legacy;

CREATE UNIQUE INDEX one_active_run_per_material
ON extraction_runs(material_path)
WHERE state NOT IN ('completed', 'invalidated');

CREATE TABLE material_briefings (
  run_id TEXT PRIMARY KEY REFERENCES extraction_runs(id) ON DELETE CASCADE,
  briefing_json TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE TABLE candidate_drafts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  draft_json TEXT NOT NULL,
  draft_sha256 TEXT NOT NULL CHECK (length(draft_sha256) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'accepted', 'abandoned')),
  write_state TEXT NOT NULL DEFAULT 'unwritten' CHECK (write_state IN ('unwritten', 'planned', 'committed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, position)
);

CREATE TABLE model_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES extraction_runs(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  provider_host TEXT NOT NULL,
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  input_bytes INTEGER NOT NULL CHECK (input_bytes >= 0),
  redaction_count INTEGER NOT NULL CHECK (redaction_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'cancelled')),
  safe_error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX workflow_events_by_operation ON workflow_events(operation_id, id);
```

Register version 5 after versions 1–4 in `migrate.ts`; add the SQL file to the copy script.

- [ ] **Step 5: Implement versioned repositories**

Repository methods must include:

```ts
export interface ExtractionRepository {
  createOrGetRun(input: CreateExtractionRun): ExtractionRun;
  sealCandidates(runId: string, expectedRunVersion: number, briefing: MaterialBriefing | null, candidates: readonly NewCandidateDraft[]): ExtractionSnapshot;
  beginZeroCandidateRetry(runId: string, expectedRunVersion: number): ExtractionSnapshot;
  acknowledgeBriefing(runId: string, expectedRunVersion: number): ExtractionSnapshot;
  updateCandidate(id: string, expectedDraftVersion: number, input: CandidateUpdate): ExtractionSnapshot;
  markCandidatesPlanned(runId: string, candidates: readonly CandidateVersionRef[]): ExtractionSnapshot;
  markCandidatesCommitted(runId: string, candidates: readonly CandidateVersionRef[], nextSourceRawSha256: string): ExtractionSnapshot;
  advanceSourceVersion(runId: string, expectedContentSha256: string, nextRawSha256: string): ExtractionSnapshot;
  getSnapshot(id: string): ExtractionSnapshot | undefined;
}
```

Use immediate transactions and expected versions. `workflow-event-repository` returns events strictly after `Last-Event-ID`, emits `stream_reset` when the cursor predates retained rows, and deletes only events older than 24 hours. Durable user actions additionally append sanitized rows to existing `audit_events`.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- extraction-repository database-kernel
npm run typecheck
```

Expected: migration preservation, active uniqueness, reversible decisions, candidate freeze and source-version advance tests pass.

Commit:

```bash
git add src/server/db/migrations/005_extraction_workflow.sql src/server/db/repositories/extraction-repository.ts src/server/events/workflow-event-repository.ts src/server/db/migrate.ts src/shared/domain/workflow.ts scripts/copy-server-assets.ts tests/integration/extraction-repository.test.ts
git commit -m "feat: persist extraction drafts and candidate states"
```

### Task 2: Compute immutable material identity and redact model input

**Files:**

- Create: `src/server/rules/source-content-identity.ts`
- Create: `src/server/ai/redaction.ts`
- Test: `tests/unit/source-content-identity.test.ts`
- Test: `tests/unit/redaction.test.ts`

- [ ] **Step 1: Write failing identity tests**

Start from a source golden fixture and assert changing only `知识入库状态` and `生成知识` preserves identity while every other byte change invalidates it:

```ts
expect(sourceContentSha256(unrefinedBytes)).toBe(sourceContentSha256(partialBytes));
expect(sourceContentSha256(unrefinedBytes)).toBe(sourceContentSha256(ingestedBytes));
expect(sourceContentSha256(unrefinedBytes)).not.toBe(sourceContentSha256(bodyEditedBytes));
expect(sourceContentSha256(unrefinedBytes)).not.toBe(sourceContentSha256(authorEditedBytes));
```

The implementation must reuse exact field ranges from Phase 2 `source-frontmatter-patch.ts`; if either mutable field cannot be safely located, return `SOURCE_CONTENT_IDENTITY_UNSAFE`.

- [ ] **Step 2: Write failing redaction tests**

Assert removal of query values named `token`, `key`, `api_key`, `signature`, `access_token`, Authorization/Cookie values, `sk-` keys and `/Users/ao` paths. Preserve Chinese paragraphs, headings and safe URL origins. Verify stable block IDs `p0001`, `p0002`, source byte ranges, redacted offsets, byte count and hash.

Use exact input and assert that neither returned text nor serialized output contains a secret:

```ts
const paragraphs = [
  '# 标题',
  '正文一，来源 https://example.com/article?token=secret&safe=1',
  'Authorization: Bearer sk-secret',
  'Cookie: session=secret',
  '本地路径 /Users/ao/private/source.md',
  '正文二'
];
const sourceText = paragraphs.join('\n\n');
const input = new TextEncoder().encode(sourceText);
const result = redactMaterial(input);
const serialized = JSON.stringify(result);

expect(result.blocks.map((block) => block.blockId)).toEqual(['p0001', 'p0002', 'p0003', 'p0004', 'p0005', 'p0006']);
for (const [index, block] of result.blocks.entries()) {
  const characterStart = sourceText.indexOf(paragraphs[index]);
  expect(block.originalByteStart).toBe(Buffer.byteLength(sourceText.slice(0, characterStart), 'utf8'));
  expect(block.originalByteEnd).toBe(block.originalByteStart + Buffer.byteLength(paragraphs[index], 'utf8'));
}
expect(serialized).toContain('https://example.com/article?safe=1');
expect(serialized).toContain('正文一');
expect(serialized).toContain('正文二');
expect(serialized).not.toMatch(/secret|sk-|\/Users\/ao/u);
expect(result.byteLength).toBe(Buffer.byteLength(result.blocks.map((block) => block.text).join('\n\n'), 'utf8'));
expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
expect(result.redactionCount).toBe(4);
```

- [ ] **Step 3: Run and verify RED**

Run:

```bash
npm run test:unit -- source-content-identity redaction
```

Expected: identity masking and redaction assertions fail.

- [ ] **Step 4: Implement deterministic identity and redaction**

Export:

```ts
export function sourceContentSha256(bytes: Uint8Array): string;

export type RedactedMaterial = {
  blocks: Array<{
    blockId: string;
    originalByteStart: number;
    originalByteEnd: number;
    text: string;
  }>;
  redactionCount: number;
  byteLength: number;
  sha256: string;
};

export function redactMaterial(bytes: Uint8Array): RedactedMaterial;
```

Identity replaces the two mutable YAML value ranges with fixed ASCII markers before hashing. Redaction splits decoded UTF-8 into ordered paragraphs before named replacements; it never logs or persists blocks.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run test:unit -- source-content-identity redaction source-frontmatter-patch
npm run typecheck
```

Expected: identity remains stable only for approved internal source updates; sensitive strings are absent from redaction output.

Commit:

```bash
git add src/server/rules/source-content-identity.ts src/server/ai/redaction.ts tests/unit/source-content-identity.test.ts tests/unit/redaction.test.ts
git commit -m "feat: identify and redact extraction sources"
```

### Task 3: Add the DeepSeek-compatible model boundary

**Files:**

- Create: `src/server/ai/model-config.ts`
- Create: `src/server/ai/compatible-client.ts`
- Create: `tests/fixtures/fake-openai-server.ts`
- Modify: `src/electron/settings-store.ts`
- Modify: `src/electron/preload.ts`
- Modify: `src/shared/desktop/bridge.ts`
- Modify: `src/client/pages/SettingsPage.tsx`
- Test: `tests/integration/ai-client.test.ts`
- Test: `tests/unit/model-settings-store.test.ts`
- Test: `tests/unit/electron-preload-model-key.test.ts`
- Test: `tests/unit/electron-preload-model-settings.test.ts`
- Modify: `src/server/start-server.ts`

- [ ] **Step 1: Write failing safeStorage and preload tests**

Mock Electron `safeStorage`, `ipcMain` and `contextBridge`. Assert `setModelApiKey` encrypts before the settings file write, the settings JSON contains ciphertext rather than plaintext, mode is `0600`, and status/set/clear return only `{ configured: boolean }`:

```ts
await bridge.setModelApiKey('test-deepseek-key');
expect(safeStorage.encryptString).toHaveBeenCalledWith('test-deepseek-key');
expect(await bridge.getModelApiKeyStatus()).toEqual({ configured: true });
expect(JSON.stringify(await readStoredSettings())).not.toContain('test-deepseek-key');
expect(await bridge.clearModelApiKey()).toEqual({ configured: false });
expect(await bridge.getModelApiKeyStatus()).toEqual({ configured: false });
```

Assert `safeStorage.isEncryptionAvailable() === false` returns `{ configured: false, safeErrorCode: 'SECURE_STORAGE_UNAVAILABLE' }` and refuses set; decrypt failure returns `{ configured: false, safeErrorCode: 'KEY_DECRYPT_FAILED' }`, disables model calls and asks the user to clear/reconfigure. There is no plaintext, base64 or home-grown encryption fallback. Browsing/editing remains available, and ciphertext, key text and exception messages containing secret material are absent from logs.

Assert untrusted sender origin is rejected; preload exposes no getter for plaintext, generic invoke/send method, filesystem, process or environment; logs, thrown errors, IPC responses, HTTP responses and SQLite contain no key.

In the same settings store test and `electron-preload-model-settings.test.ts`, assert the default non-secret config is `{ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' }`; this is the current [official OpenAI-compatible preset](https://api-docs.deepseek.com/) verified for the 2026-09-05 plan revision, while Phase 6's real smoke remains the release-time availability proof. `getModelEndpointSettings` and `setModelEndpointSettings` round-trip only those two fields through fixed IPC channels. Reject HTTP except loopback in tests, URL credentials, query/hash, non-HTTP(S) schemes, an over-2048-byte URL, empty/over-128-byte model names, control characters and unknown keys. The endpoint/model may be stored as plaintext generic settings; the API key remains a separate ciphertext field and is never included in this result.

- [ ] **Step 2: Write a failing real-HTTP compatible-client test**

Start the fake server on a random loopback port and assert one request to `/chat/completions`:

```ts
const client = createCompatibleClient({
  config: { baseUrl: server.baseUrl, model: 'deepseek-v4-flash', timeoutMs: 20_000 },
  secretProvider: { getApiKey: async () => 'test-secret' },
  fetchImplementation: fetch
});
const result = await client.complete({ messages, responseFormat: 'json_object' });
expect(server.requests[0]?.authorization).toBe('Bearer test-secret');
expect(server.requests[0]?.body).toMatchObject({
  model: 'deepseek-v4-flash',
  response_format: { type: 'json_object' }
});
expect(result.content).toBe('{"briefing":null,"candidates":[]}');
```

Assert missing key, timeout, abort, 401, 429, 500, oversized response, non-JSON envelope and missing assistant content map to stable safe codes without response bodies.

Start two fake loopback servers. Save server A/model A, complete once, then save server B/model B and complete again through the same client instance. Assert the second request goes only to B with model B, proving each call reads the latest `ModelConfigProvider` value and no App restart is required.

- [ ] **Step 3: Run and verify RED**

Run:

```bash
npm run test:unit -- model-settings-store electron-preload-model-key electron-preload-model-settings
npm run test:integration -- ai-client
```

Expected: the encrypted model-key IPC, client and secret boundary are absent.

- [ ] **Step 4: Implement the single-purpose model-key bridge**

Extend `src/shared/desktop/bridge.ts` with exactly:

```ts
export type ModelApiKeyStatus = {
  readonly configured: boolean;
  readonly safeErrorCode?: 'SECURE_STORAGE_UNAVAILABLE' | 'KEY_DECRYPT_FAILED';
};
export type ModelEndpointSettings = {
  readonly baseUrl: string;
  readonly model: string;
};

export interface XiaozhaoDesktopApi {
  getModelApiKeyStatus(): Promise<ModelApiKeyStatus>;
  setModelApiKey(value: string): Promise<ModelApiKeyStatus>;
  clearModelApiKey(): Promise<ModelApiKeyStatus>;
  getModelEndpointSettings(): Promise<ModelEndpointSettings>;
  setModelEndpointSettings(value: ModelEndpointSettings): Promise<ModelEndpointSettings>;
}
```

This declaration extends Phase 0's same `XiaozhaoDesktopApi`; it does not introduce a second bridge type or browser global. `src/electron/preload.ts` adds only those functions to the existing frozen `window.xiaozhaoDesktop` object through fixed IPC channel names. `src/electron/settings-store.ts` validates a nonempty bounded key in the trusted main-process handler, requires `safeStorage.isEncryptionAvailable()`, calls `safeStorage.encryptString`, writes ciphertext to its private settings file with `0600`, and decrypts only when its server-side `ModelSecretProvider.getApiKey()` is invoked. Clear removes ciphertext. Safe-storage/decrypt failures return only the stable safe code and never fall back. Neither status nor set/clear returns plaintext, and the key never travels through HTTP or SQLite. Endpoint settings use the strict URL/model validation from Step 1, return only non-secret values and never share a setter or record with the encrypted key.

- [ ] **Step 5: Implement model config and client**

Use these interfaces:

```ts
export type ModelRuntimeConfig = {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxInputBytes: number;
};

export interface ModelSecretProvider {
  getApiKey(): Promise<string | undefined>;
}

export interface ModelConfigProvider {
  getConfig(): Promise<ModelRuntimeConfig>;
}

export const MODEL_MAX_INPUT_BYTES = 512_000;

export const DEEPSEEK_PRESET: ModelRuntimeConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  timeoutMs: 60_000,
  maxInputBytes: MODEL_MAX_INPUT_BYTES
};
```

Normalize one trailing slash and append `chat/completions`; require HTTPS except an explicit loopback test URL under `NODE_ENV=test`; reject credentials/query/hash; validate model and URL at the Electron store and again at the server provider boundary. On every `complete()` call, read the latest config, construct the exact UTF-8 JSON request body once, and reject bodies above `MODEL_MAX_INPUT_BYTES` with `MODEL_INPUT_TOO_LARGE` before `fetch`; do not truncate, chunk, call the provider or persist candidates. Cap response bytes and merge caller abort with timeout abort. Long-document chunking is explicitly outside this phase. Never expose the secret provider to a route or renderer.

- [ ] **Step 6: Inject the configured client and wire Settings UI**

Phase 0 establishes the generic Electron settings store under `src/electron`; this task extends it with a `safeStorage`-encrypted model-key adapter plus validated non-secret endpoint settings. `startServer` receives the same store through narrow `ModelSecretProvider` and `ModelConfigProvider` ports, builds the client once, and injects it into `AIOrchestrator`; each request reads current endpoint/model, so saving settings applies to the next generation without restart. An unconfigured key leaves browse/edit features ready and makes preview return model metadata with `configured: false`.

`SettingsPage` reads configured status through `window.xiaozhaoDesktop.getModelApiKeyStatus()`, sends the key input once through `setModelApiKey`, clears the input immediately after success, and offers a separate clear action. `SECURE_STORAGE_UNAVAILABLE` explains that secure model storage is unavailable and keeps model actions disabled; `KEY_DECRYPT_FAILED` offers clear/reconfigure without displaying exception or ciphertext. It loads editable `baseUrl` and `model` fields through `getModelEndpointSettings`, saves them only through `setModelEndpointSettings`, displays field-specific validation errors, and states `保存后下一次提炼生效，无需重启`. It never reads the stored key back and never puts the key in URL, HTTP state, localStorage or sessionStorage.

```ts
const modelClient = new CompatibleModelClient({
  configProvider: input.modelConfigProvider,
  secretProvider: input.modelSecretProvider,
  fetch: input.fetch,
});
const orchestrator = new AIOrchestrator({ modelClient, extractionRepository, ruleCompatibilityGate });
```

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- ai-client health-connections
npm run test:unit -- model-settings-store electron-preload-model-key electron-preload-model-settings
npm run test:security -- health-secrets
npm run typecheck
```

Expected: compatible request, live endpoint/model switching, invalid setting, input-size and safe-error tests pass; key text is absent from logs, API responses and SQLite.

Commit:

```bash
git add src/server/ai/model-config.ts src/server/ai/compatible-client.ts src/server/start-server.ts src/electron/settings-store.ts src/electron/preload.ts src/shared/desktop/bridge.ts src/client/pages/SettingsPage.tsx tests/fixtures/fake-openai-server.ts tests/integration/ai-client.test.ts tests/unit/model-settings-store.test.ts tests/unit/electron-preload-model-key.test.ts tests/unit/electron-preload-model-settings.test.ts
git commit -m "feat: add secure deepseek-compatible client"
```

### Task 4: Validate and generate evidence-backed candidates

**Files:**

- Create: `src/server/ai/schemas.ts`
- Create: `src/server/ai/prompts.ts`
- Create: `src/server/ai/orchestrator.ts`
- Create: `src/server/rules/candidate-validator.ts`
- Test: `tests/unit/candidate-validator.test.ts`
- Test: `tests/integration/ai-orchestrator.test.ts`

- [ ] **Step 1: Write failing strict-output tests**

Assert `未看` requires 3–6 briefing sentences, key points and usefulness; `已看` permits `briefing: null`; knowledge type is an exact current enum; keywords are 3–6; conclusion/body/evidence are nonempty; every evidence range exists and its excerpt hash matches. Unknown keys, model-supplied YAML/status/date, nonexistent topic nodes, disallowed paths or one invalid candidate reject the entire response and persist zero candidates. A strict response with `candidates: []` is valid for both reading states and is persisted as a completed zero-candidate result rather than retried or padded with hallucinated knowledge.

Add exact input-boundary tests: a serialized redacted request of `MODEL_MAX_INPUT_BYTES` may call the fake server; one byte above returns `MODEL_INPUT_TOO_LARGE`, records only sanitized request metadata, makes zero fetch calls and persists zero candidates. The request is not truncated or chunked. Persist an approved fingerprint, stop the runtime, change a rule file and restart; preview/start/retry return `RULE_BUNDLE_UNAPPROVED`, perform no secret lookup or provider call and persist no candidate. Repeated restart remains blocked until a separate compatibility approval updates the approved fingerprint.

Express the all-or-nothing and byte-boundary behavior with the same schema and orchestrator used in production:

```ts
it.each([
  { readingState: '未看', response: { briefing: null, candidates: [] } },
  { readingState: '已看', response: { briefing: null, candidates: [{ ...validCandidate, keywords: ['only-two', 'keywords'] }] } },
  { readingState: '已看', response: { briefing: null, candidates: [{ ...validCandidate, evidence: [{ blockId: 'missing', excerptSha256: '0'.repeat(64) }] }] } },
  { readingState: '已看', response: { briefing: null, candidates: [{ ...validCandidate, status: '已入库' }] } }
])('rejects the complete response atomically', async ({ readingState, response }) => {
  fakeModel.enqueue(response);
  await expect(orchestrator.generate(makeApprovedRequest({ readingState })))
    .rejects.toMatchObject({ code: expect.any(String) });
  expect(repository.listCandidates(runId)).toEqual([]);
});

it.each([
  [MODEL_MAX_INPUT_BYTES, 1, undefined],
  [MODEL_MAX_INPUT_BYTES + 1, 0, 'MODEL_INPUT_TOO_LARGE']
] as const)('enforces %i serialized UTF-8 bytes', async (byteLength, fetchCount, code) => {
  const request = makeApprovedRequestWithSerializedByteLength(byteLength);
  const result = orchestrator.generate(request);
  if (code === undefined) await expect(result).resolves.toBeDefined();
  else await expect(result).rejects.toMatchObject({ code });
  expect(fakeModel.fetchCount).toBe(fetchCount);
  expect(repository.listCandidates(runId)).toEqual(code === undefined ? validPersistedCandidates : []);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:unit -- candidate-validator
npm run test:integration -- ai-orchestrator
```

Expected: strict schema, evidence and all-or-nothing tests fail.

- [ ] **Step 3: Define the model-only schema**

The outer response and candidate schemas contain only model proposal fields:

```ts
export const materialBriefingSchema = z.object({
  sentences: z.array(z.string().trim().min(1).max(1_000)).min(3).max(6),
  keyPoints: z.array(z.string().trim().min(1).max(1_000)).min(1).max(8),
  usefulness: z.string().trim().min(1).max(2_000),
  caution: z.string().trim().min(1).max(2_000).optional()
}).strict();

export const modelCandidateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  knowledgeType: z.enum(KNOWLEDGE_TYPES),
  suggestedPath: z.string().min(1).max(1024),
  topics: z.array(z.string().min(1).max(256)).max(20),
  keywords: z.array(z.string().min(1).max(64)).min(3).max(6),
  scenarios: z.array(z.string().min(1).max(500)).min(1).max(6),
  conclusion: z.string().trim().min(1).max(4_000),
  keyPoints: z.array(z.string().min(1).max(1_000)).min(1).max(8),
  boundary: z.string().trim().min(1).max(4_000),
  bodyMarkdown: z.string().trim().min(1).max(100_000),
  value: z.string().trim().min(1).max(2_000),
  evidence: z.array(modelEvidenceSchema).min(1).max(20),
  sourceContribution: z.string().trim().min(1).max(2_000)
}).strict();

export const modelExtractionResponseSchema = z.object({
  briefing: materialBriefingSchema.nullable(),
  candidates: z.array(modelCandidateSchema).max(12)
}).strict();
```

The orchestrator adds the reading-state rule after parsing: `未看` rejects `briefing: null`; `已看` accepts either a valid briefing or null. The candidates array deliberately has no `.min(...)`; zero worthwhile candidates is a first-class outcome.

- [ ] **Step 4: Implement prompt and orchestrator**

Prompt input is exactly the reading state, relative source path, redacted blocks, fingerprinted rule excerpt and no more than 12 nearby knowledge cards containing title/path/usage status/recall fields. It explicitly states that the model cannot write files or decide formal status and must return `candidates: []` when no knowledge is worth formalizing rather than filling a quota.

The orchestrator first reloads the full bundle and calls the injected `RuleCompatibilityGate.assertApproved(currentSha256)`. On `RULE_BUNDLE_UNAPPROVED` it stops before redaction persistence, secret lookup and fetch. It then builds the exact redacted JSON body and UTF-8 byte count used by preview and send. If over limit it records `MODEL_INPUT_TOO_LARGE` and stops before secret lookup/fetch. Otherwise it records request metadata, calls the client once, parses one JSON object, validates the complete output, assigns IDs/positions/versions and seals the briefing plus all candidates—including an empty array—in one repository transaction. Store no prompt, source body or full response.

```ts
const approval = await ruleCompatibilityGate.assertApproved(bundle.fingerprint);
const request = buildRedactedModelRequest({ source, readingState, matches, approval });
if (Buffer.byteLength(request.serialized, 'utf8') > MODEL_MAX_INPUT_BYTES) {
  throw new AppError('MODEL_INPUT_TOO_LARGE');
}
const parsed = modelExtractionResponseSchema.parse(await modelClient.complete(request));
return extractionRepository.sealGeneratedResult(runId, assignCandidateIds(parsed));
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run test:unit -- candidate-validator
npm run test:integration -- ai-orchestrator ai-client
npm run typecheck
```

Expected: valid nonempty and zero-candidate outputs persist atomically; every malformed or unsafe response leaves zero candidates and a retryable sanitized event; oversized input never calls the provider.

Commit:

```bash
git add src/server/ai/schemas.ts src/server/ai/prompts.ts src/server/ai/orchestrator.ts src/server/rules/candidate-validator.ts tests/unit/candidate-validator.test.ts tests/integration/ai-orchestrator.test.ts
git commit -m "feat: validate deepseek extraction candidates"
```

### Task 5: Implement extraction lifecycle and historical partial recovery

**Files:**

- Create: `src/server/workflow/extraction-service.ts`
- Create: `src/server/workflow/knowledge-match-service.ts`
- Test: `tests/integration/extraction-service.test.ts`
- Test: `tests/integration/historical-partial-recovery.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Cover:

1. `未提炼` without a run creates one; duplicate start returns it.
2. Same `sourceContentSha256` resumes even after a legitimate source status/link update advances raw hash.
3. Body or immutable metadata changes invalidate the run and return `VERSION_CONFLICT`.
4. `部分入库` without local state enters `historical_partial` and preserves existing `生成知识` as a read-only baseline.
5. Candidate matching searches title and YAML recall fields only.
6. Candidate edits and decisions increment only their draft version plus snapshot version.
7. A valid zero-candidate result can be retried with expected run version and a fresh preview hash; a nonempty universe cannot use that shortcut.
8. No operation mutates the vault.

Implement those cases against one byte-counting read gateway and an always-failing mutation spy:

```ts
it('resumes by source content identity and rejects immutable source changes', async () => {
  const first = await service.start(makeStartInput({ status: '未提炼' }), 'start-1');
  gateway.setSource(statusOnlyUpdate(first.sourceBytes, '部分入库'));
  expect((await service.start(makeStartInput({ status: '部分入库' }), 'start-2')).id).toBe(first.id);
  gateway.setSource(bodyUpdate(first.sourceBytes, '正文变化'));
  await expect(service.start(makeStartInput({ status: '部分入库' }), 'start-3'))
    .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  expect(mutationPort.calls).toEqual([]);
});

it('reconstructs historical partial as a read-only baseline', async () => {
  gateway.setSource(makeHistoricalPartialSource(['[[知识A]]', '[[知识B]]']));
  const snapshot = await service.start(makeStartInput({ status: '部分入库' }), 'historical-1');
  expect(snapshot.mode).toBe('historical_partial');
  expect(snapshot.existingKnowledgeLinks).toEqual(['知识A', '知识B']);
  expect(snapshot.warning).toBe('历史部分入库：旧候选与旧决策无法恢复。本轮将保留现有生成知识，并只审阅重新识别的未覆盖候选。');
  expect(mutationPort.calls).toEqual([]);
});

it('allows retry only for a version-matched empty candidate universe', async () => {
  const empty = await repository.seedCompletedRun({ candidates: [] });
  await expect(service.retryZeroCandidateRun(empty.id, {
    expectedRunVersion: empty.version,
    previewSha256: currentPreviewSha256
  }, 'retry-1')).resolves.toBeDefined();
  await repository.seedCandidate(empty.id, validCandidate);
  await expect(service.retryZeroCandidateRun(empty.id, {
    expectedRunVersion: empty.version + 1,
    previewSha256: currentPreviewSha256
  }, 'retry-2')).rejects.toMatchObject({ code: 'CANDIDATE_UNIVERSE_NOT_EMPTY' });
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:integration -- extraction-service historical-partial
```

Expected: lifecycle and historical recovery tests fail.

- [ ] **Step 3: Implement the service boundary**

Expose:

```ts
export interface ExtractionService {
  preview(input: ExtractionPreviewInput): Promise<ExtractionPreview>;
  start(input: StartExtractionInput, idempotencyKey: string): Promise<ExtractionSnapshot>;
  get(id: string): ExtractionSnapshot;
  acknowledgeBriefing(id: string, expectedRunVersion: number): ExtractionSnapshot;
  updateCandidate(id: string, input: CandidateUpdateInput): ExtractionSnapshot;
  retryZeroCandidateRun(id: string, input: RetryExtractionInput, idempotencyKey: string): Promise<ExtractionSnapshot>;
}
```

Every preview/start/retry rereads source bytes, validates `类型: 原始资料`, `处理状态: 已归档` and `知识入库状态` in `未提炼 | 部分入库`, loads the current rule fingerprint, requires it is still the approved fingerprint, and computes both source hashes. `RULE_BUNDLE_UNAPPROVED` is returned before starting or retrying a model request and cannot be cleared by creating a new run. Retry requires the same content identity, current raw hash, zero persisted candidates, expected run version and current preview hash. Historical recovery returns this exact warning:

```text
历史部分入库：旧候选与旧决策无法恢复。本轮将保留现有生成知识，并只审阅重新识别的未覆盖候选。
```

- [ ] **Step 4: Implement YAML-only knowledge matching**

Rank indexed knowledge by exact/normalized title and overlaps in topics, keywords, scenarios and conclusion. Return path, usage status, reasons and score. Never read or send knowledge body automatically.

```ts
return index.searchRecallFields(candidate).map((match) => ({
  path: match.path,
  usageStatus: match.frontmatter['使用状态'],
  reasons: explainRecallOverlap(candidate, match.frontmatter),
  score: scoreRecallOverlap(candidate, match.frontmatter),
}));
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- extraction-service historical-partial
npm run typecheck
```

Expected: resume, conflict, historical baseline, matching and zero-mutation assertions pass.

Commit:

```bash
git add src/server/workflow/extraction-service.ts src/server/workflow/knowledge-match-service.ts tests/integration/extraction-service.test.ts tests/integration/historical-partial-recovery.test.ts
git commit -m "feat: manage extraction review lifecycle"
```

### Task 6: Expose extraction and resumable event APIs

**Files:**

- Create: `src/server/api/routes/extraction-previews.ts`
- Create: `src/server/api/routes/extraction-runs.ts`
- Create: `src/server/api/routes/candidates.ts`
- Create: `src/server/api/routes/workflow-events.ts`
- Create: `src/server/events/sse.ts`
- Modify: `src/shared/api/schemas.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/api/client.ts`
- Test: `tests/integration/extraction-api.test.ts`
- Test: `tests/integration/sse-resume.test.ts`
- Test: `tests/component/api-client.test.tsx`

- [ ] **Step 1: Write failing API tests**

Assert these contracts:

```text
POST  /api/v1/extraction-previews
POST  /api/v1/extraction-runs
GET   /api/v1/extraction-runs/:id
POST  /api/v1/extraction-runs/:id/briefing-acknowledgement
POST  /api/v1/extraction-runs/:id/retry
PATCH /api/v1/candidates/:id
GET   /api/v1/workflow-events?operationId=:id
```

Preview requires material path, expected raw hash and reading state; response includes provider host/model, configured flag, redaction count, exact serialized request `inputBytes`, fixed `maxInputBytes`, `inputTooLarge`, redacted blocks, selected context titles and `previewHash`, without calling the model. Start requires the current preview hash, CSRF and idempotency; if `inputTooLarge` it returns stable `MODEL_INPUT_TOO_LARGE` before secret lookup/provider call. Retry additionally requires expected run version and is legal only after a valid zero-candidate result. Candidate patch requires expected draft version and a complete validated draft/decision. `Last-Event-ID` resumes at the next row; an expired ID sends `stream_reset` with a relative snapshot URL.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:integration -- extraction-api sse-resume
```

Expected: routes are absent.

- [ ] **Step 3: Add strict API schemas and service-only routes**

All objects use `.strict()`. Start body is:

```ts
z.object({
  materialPath: vaultPathSchema,
  expectedSourceRawSha256: sha256Schema,
  readingState: z.enum(['已看', '未看']),
  previewHash: sha256Schema
}).strict();
```

Routes call `ExtractionService` only. SSE heartbeats contain no data and consume no event ID. No URL contains session, CSRF or API key.

- [ ] **Step 4: Extend the browser API**

Add typed methods for preview, start, retry zero-candidate run, get snapshot, acknowledge briefing, update candidate and subscribe/reload events. Map `MODEL_UNCONFIGURED`, `SECURE_STORAGE_UNAVAILABLE`, `KEY_DECRYPT_FAILED`, `MODEL_INPUT_TOO_LARGE`, `MODEL_RATE_LIMITED`, `MODEL_TIMEOUT`, `VERSION_CONFLICT`, `RULE_BUNDLE_UNAPPROVED` and `RULE_BUNDLE_STALE` to stable Chinese page states.

```ts
export interface ExtractionApiClient {
  preview(input: ExtractionPreviewInput): Promise<ExtractionPreview>;
  start(input: StartExtractionInput, idempotencyKey: string): Promise<ExtractionSnapshot>;
  retry(runId: string, input: RetryExtractionInput, idempotencyKey: string): Promise<ExtractionSnapshot>;
  getSnapshot(runId: string): Promise<ExtractionSnapshot>;
  acknowledgeBriefing(runId: string, expectedRunVersion: number): Promise<ExtractionSnapshot>;
  updateCandidate(candidateId: string, input: CandidateUpdateInput): Promise<ExtractionSnapshot>;
  subscribeWorkflowEvents(input: {
    operationId: string;
    lastEventId?: string;
    onEvent(event: WorkflowEvent): void;
    onReset(snapshotUrl: string): void;
  }): () => void;
}

export const extractionErrorState = {
  MODEL_UNCONFIGURED: '请先在设置中配置模型',
  SECURE_STORAGE_UNAVAILABLE: '当前设备无法安全保存模型密钥',
  KEY_DECRYPT_FAILED: '模型密钥读取失败，请重新保存',
  MODEL_INPUT_TOO_LARGE: '资料超过本版单次提炼上限',
  MODEL_RATE_LIMITED: '模型请求过于频繁，请稍后重试',
  MODEL_TIMEOUT: '模型响应超时，可安全重试',
  VERSION_CONFLICT: '资料已变化，请重新载入',
  RULE_BUNDLE_UNAPPROVED: '规则尚未批准，当前仅可审阅',
  RULE_BUNDLE_STALE: '规则已变化，请重新生成预览'
} as const;
```

All mutating methods reuse the existing session/CSRF helper; `start` and `retry` add the idempotency header. The event subscriber accepts only the server-provided relative reset URL, resumes with `Last-Event-ID`, and returns an unsubscribe function that closes the stream.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run test:integration -- extraction-api sse-resume local-http-security
npm run test:component -- api-client
npm run typecheck
```

Expected: schema, CSRF, idempotency, stale preview, exact input-size boundary, zero-candidate retry, resume and secret-redaction tests pass.

Commit:

```bash
git add src/server/api/routes/extraction-previews.ts src/server/api/routes/extraction-runs.ts src/server/api/routes/candidates.ts src/server/api/routes/workflow-events.ts src/server/events/sse.ts src/shared/api/schemas.ts src/server/app.ts src/client/api/client.ts tests/integration/extraction-api.test.ts tests/integration/sse-resume.test.ts tests/component/api-client.test.tsx
git commit -m "feat: expose extraction review APIs"
```

### Task 7: Build the three-column review workbench

**Files:**

- Create: `src/client/pages/ExtractionWorkbenchPage.tsx`
- Create: `src/client/components/extraction/ReadingStateGate.tsx`
- Create: `src/client/components/extraction/ModelInputPreview.tsx`
- Create: `src/client/components/extraction/MaterialBriefingPanel.tsx`
- Create: `src/client/components/extraction/SourceReader.tsx`
- Create: `src/client/components/extraction/CandidateList.tsx`
- Create: `src/client/components/extraction/CandidateEditor.tsx`
- Create: `src/client/components/extraction/KnowledgeMatches.tsx`
- Create: `src/client/styles/extraction.css`
- Modify: `src/client/app/router.tsx`
- Modify: `src/client/pages/DashboardPage.tsx`
- Modify: `src/client/pages/QueuePage.tsx`
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `src/client/pages/OperationsPage.tsx`
- Test: `tests/component/extraction-workbench.test.tsx`

- [ ] **Step 1: Write failing component tests**

Assert no evidence defaults to `未看`; input preview displays destination, redaction count, exact `inputBytes / maxInputBytes`, content and context titles before generation; changed source invalidates preview; an oversized preview labels `输入超过单次提炼上限`, disables generation and offers no silent truncation/chunk action. `未看` blocks candidates until briefing acknowledgement; source is searchable/selectable and read-only; every candidate field is editable; decisions are reversible; invalid edits cannot be accepted; reload restores server state; pending candidates do not prevent saving other decisions. A completed empty result renders `未发现可入库候选` with separate `重新提炼` and `确认无候选并结案` actions; the latter enters Phase 4's reviewed source-only write confirmation and never changes source status in Phase 3.

Add visual-contract assertions rather than a new theme: panels consume the existing `--surface-void`, `--surface-glass`, `--border-*`, `--accent-primary`, `--status-amber`, `--status-red` and `--status-blue` tokens. Every candidate, model and write state exposes readable text plus an icon and `data-tone`; red is only failure/conflict, amber is pending confirmation, blue is auxiliary information, and green is active/success. Long source/editor/preview regions carry the no-blur class. Stub `matchMedia('(prefers-reduced-motion: reduce)')` and assert decorative transitions/stack motion are disabled while focus and loading state remain understandable.

Cover the user-visible gates with accessible queries rather than snapshots alone:

```tsx
render(<ExtractionWorkbenchPage />, { wrapper: createTestApp({ snapshot: unrefinedSnapshot }) });
expect(screen.getByText('阅读状态判断：未看')).toBeVisible();
expect(screen.getByRole('button', { name: '生成候选' })).toBeDisabled();
await userEvent.click(screen.getByRole('button', { name: '查看发送内容' }));
expect(screen.getByText(`${preview.inputBytes} / ${preview.maxInputBytes}`)).toBeVisible();
expect(screen.getByText(preview.destination)).toBeVisible();

server.use(extractionSnapshotHandler(emptyCompletedSnapshot));
await userEvent.click(screen.getByRole('button', { name: '刷新' }));
expect(screen.getByText('未发现可入库候选')).toBeVisible();
expect(screen.getByRole('button', { name: '重新提炼' })).toBeEnabled();
await userEvent.click(screen.getByRole('button', { name: '确认无候选并结案' }));
expect(navigate).toHaveBeenCalledWith(`/write-confirmation/${emptyCompletedSnapshot.runId}`);
expect(updateSourceStatus).not.toHaveBeenCalled();

expect(document.querySelector('.extraction-source')).toHaveClass('no-blur');
expect(screen.getAllByTestId('workflow-state').every((node) =>
  Boolean(node.textContent) && Boolean(node.getAttribute('data-tone'))
)).toBe(true);
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm run test:component -- extraction-workbench
```

Expected: the current inert extraction route lacks the review controls and fails the first behavioral assertion.

- [ ] **Step 3: Implement preview, reading gate and briefing**

The explicit button sequence is `查看发送内容` then `生成候选`; cancellation returns to queue without model request. Preview uses the server's exact byte count and blocks at `MODEL_INPUT_TOO_LARGE`. `MaterialBriefingPanel` requires persisted acknowledgement. Always display `阅读状态判断：已看` or `阅读状态判断：未看`. Empty results show the explicit no-candidate state; retry creates a fresh guarded model request, while close routes to the Phase 4 source-only confirmation with `closeRun: true`.

```tsx
<ReadingStateGate readingState={snapshot.readingState} acknowledged={snapshot.briefingAcknowledged}>
  <ModelInputPreview preview={preview} onGenerate={generateCandidates} />
  <MaterialBriefingPanel briefing={snapshot.briefing} onAcknowledge={acknowledgeBriefing} />
</ReadingStateGate>
```

- [ ] **Step 4: Implement source, candidate and match panels**

Use a desktop three-column grid at 1280px; source and editor scroll independently and long-form panels explicitly set `backdrop-filter: none`. Reuse the existing near-black/glass/silver-border/fluorescent-green tokens; do not add a second palette or theme file. Candidate saves send `expectedDraftVersion` and replace local state only with the authoritative response. Evidence selection scrolls to the matching `blockId`. Show `未写入`, `计划中`, `已写入` independently from `待确认`, `已接受`, `已放弃`, always with text + icon + permitted token color. Add a `prefers-reduced-motion: reduce` rule that removes nonessential transform/transition/stack animation.

```css
.extraction-workbench { display: grid; grid-template-columns: minmax(280px, 0.9fr) minmax(260px, 0.8fr) minmax(380px, 1.3fr); }
.extraction-source, .extraction-editor { overflow: auto; backdrop-filter: none; }
@media (prefers-reduced-motion: reduce) {
  .extraction-workbench * { transition: none !important; transform: none !important; }
}
```

- [ ] **Step 5: Wire entry points and diagnostics**

Dashboard `开始提炼` and Queue `开始提炼/继续处理` route to `/extractions/:id`; historical partial shows the exact warning. Settings shows DeepSeek host/model/configured/last safe error without key. Operations shows request metadata and decisions without source or prompt.

```tsx
<Route path="extractions/:id" element={<ExtractionWorkbenchPage />} />
```

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run test:component -- extraction-workbench read-pages
npm run typecheck
```

Expected: workbench component behavior, accessibility and entry-point routing pass; the end-to-end refresh journey remains red until Task 8 adds its fixture and spec.

Commit:

```bash
git add src/client/pages/ExtractionWorkbenchPage.tsx src/client/components/extraction/ReadingStateGate.tsx src/client/components/extraction/ModelInputPreview.tsx src/client/components/extraction/MaterialBriefingPanel.tsx src/client/components/extraction/SourceReader.tsx src/client/components/extraction/CandidateList.tsx src/client/components/extraction/CandidateEditor.tsx src/client/components/extraction/KnowledgeMatches.tsx src/client/styles/extraction.css src/client/app/router.tsx src/client/pages/DashboardPage.tsx src/client/pages/QueuePage.tsx src/client/pages/SettingsPage.tsx src/client/pages/OperationsPage.tsx tests/component/extraction-workbench.test.tsx
git commit -m "feat: add deepseek extraction workbench"
```

### Task 8: Verify the complete draft-only journey

**Files:**

- Create: `tests/e2e/extraction-draft-flow.spec.ts`
- Create: `tests/e2e/extraction-draft-flow.spec.ts-snapshots/extraction-workbench-1440x900-chromium-darwin.png`
- Modify: `tests/e2e/fixture-server.ts`

- [ ] **Step 1: Add deterministic fixtures**

Serve one `未提炼`, one local `部分入库` run, and one historical `部分入库` source with two existing `生成知识` links. Fake DeepSeek returns one briefing and three valid candidates including a match to `已优化` knowledge. Add a valid `{ briefing, candidates: [] }` response and a source whose exact redacted request is one byte above `MODEL_MAX_INPUT_BYTES`.

```ts
const modelFixtures = {
  normal: { briefing: validBriefing, candidates: [candidateA, candidateB, candidateC] },
  empty: { briefing: validBriefing, candidates: [] },
  oversizedSourceBytes: MODEL_MAX_INPUT_BYTES + 1,
} as const;
```

- [ ] **Step 2: Prove review persistence and zero mutation**

Drive:

```text
Dashboard → 开始提炼 → 未看 → 查看发送内容 → 生成候选
→ 确认概述 → 编辑候选 → 接受一条 → 放弃一条 → 保留一条待确认
→ 刷新窗口 → 所有草稿和决策仍在
```

Drive historical recovery and assert existing generated links remain visible. Spy on every mutation method of the gateway and `WriteCoordinator`; call count must remain zero.

Drive the empty response and assert `未发现可入库候选`, retry, and explicit close controls are distinct. Drive the oversized source and assert the byte limit is visible, provider request count remains unchanged, and no candidate/model response is persisted. Phase 3's close control may navigate to the Phase 4 confirmation route contract, but it must not mutate the source in this phase.

At a fixed 1440×900 viewport and dark color scheme, wait for fonts/data, disable animations and capture `extraction-workbench-1440x900.png` with `toHaveScreenshot`. The reviewed baseline must retain the existing near-black glass shell, silver borders and fluorescent-green active state; it must show amber pending, blue auxiliary and no red except a deliberately rendered failure fixture. Repeat the key layout assertion with `reducedMotion: 'reduce'` and require no nonessential animated transform.

- [ ] **Step 3: Run Phase 3 verification**

Run:

```bash
npm run test:unit -- source-content-identity redaction candidate-validator
npm run test:integration -- extraction-repository ai-client ai-orchestrator extraction-service historical-partial extraction-api sse-resume
npm run test:component -- extraction-workbench api-client
npm run test:e2e -- extraction-draft-flow
npm run build
```

Expected: all commands exit 0, fake model output is deterministic, no formal or temporary vault mutation occurs during extraction review.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/extraction-draft-flow.spec.ts tests/e2e/extraction-draft-flow.spec.ts-snapshots/extraction-workbench-1440x900-chromium-darwin.png tests/e2e/fixture-server.ts
git commit -m "test: prove the draft-only extraction journey"
```

## Phase 3 Exit Criteria

- DeepSeek Key remains in the Phase 0 Electron settings store extended with `safeStorage` and is never returned to the renderer.
- User sees the exact redacted payload, byte count, model and selected YAML context before sending.
- Invalid or partial model output persists zero candidates.
- Source identity survives only App-owned status/link updates; real content changes invalidate the run.
- Candidate decisions and draft versions survive restart and are independently mutable while unwritten.
- Historical partial materials retain all existing generated links.
- This phase performs zero vault mutations and leaves accepted candidate subsets ready for Phase 4.

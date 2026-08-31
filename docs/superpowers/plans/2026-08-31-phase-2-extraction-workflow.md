# Phase 2 AI Extraction and Human Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Let the user start or recover an extraction, see the required read-status briefing, edit and decide every structured candidate, and persist the entire draft workflow without writing any formal Obsidian note.

**Architecture:** ExtractionService owns one active run per source path and raw hash. AIOrchestrator sends one redacted source plus a small YAML-only knowledge context to an OpenAI-compatible endpoint, validates MaterialBriefing and candidates, and seals a candidateSetHash. SQLite persists run versions, briefing acknowledgement, drafts, decisions, model metadata, and events.

**Tech Stack:** Existing stack, native server-side fetch for OpenAI-compatible chat completions, Zod structured output, SQLite, SSE, React

---

Prerequisites: Phase 1 passes. Formal writes remain disabled even if G2 passes; this phase ends at ready_to_plan.

### Task 1: Add extraction workflow persistence

**Files:**
- Create: src/server/db/migrations/003_extraction_workflow.sql
- Create: src/server/db/repositories/extraction-repository.ts
- Create: src/server/db/repositories/event-repository.ts
- Create: src/shared/domain/workflow.ts
- Test: tests/integration/extraction-repository.test.ts

- [ ] **Step 1: Write failing repository tests**

Assert:

- the same material path + source hash returns the existing active run;
- a different hash invalidates the old run before creating a new one;
- only 已看 and 未看 are accepted;
- candidate order is stable;
- draft edits increment candidate and run versions;
- decision changes accepted to rejected and back before a batch exists;
- every edit invalidates any plan marker;
- event ids are monotonic and retained for 24 hours;
- completed and invalidated runs no longer block a new run.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:integration -- extraction-repository
~~~

Expected: the suite loads and fails at uniqueness, version, transition, or event-retention assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Define shared workflow types**

Create src/shared/domain/workflow.ts:

~~~ts
export type ReadingState = '已看' | '未看';
export type CandidateDecision = 'pending' | 'accepted' | 'rejected';
export type ExtractionState =
  | 'generating'
  | 'reviewing'
  | 'ready_to_plan'
  | 'completed'
  | 'invalidated'
  | 'recovery_required';

export type MaterialBriefing = {
  summary: string[];
  keyPoints: string[];
  usefulness: string[];
  caution?: string;
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
  evidence: Array<{
    blockId: string;
    startInRedactedBlock: number;
    endInRedactedBlock: number;
    excerptHash: string;
  }>;
  sourceContribution: string;
  decision: CandidateDecision;
  version: number;
};
~~~

- [ ] **Step 4: Add the migration**

003_extraction_workflow.sql creates:

~~~sql
CREATE TABLE material_briefings (
  run_id TEXT PRIMARY KEY REFERENCES extraction_runs(id) ON DELETE CASCADE,
  briefing_json TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE TABLE candidate_drafts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  draft_json TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'accepted', 'rejected')),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, position)
);

CREATE TABLE model_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  input_bytes INTEGER NOT NULL,
  redaction_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE operation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX operation_events_by_operation
ON operation_events(operation_id, id);
~~~

Do not store source bodies, full prompts, API keys, or full model responses in these tables.

- [ ] **Step 5: Implement repositories**

Use transactions for create-run, seal-candidates, edit-candidate, change-decision, acknowledge-briefing, and complete-review. complete-review must count pending rows in SQL and refuse while count is non-zero. Compute the sealed candidateSetHash from sourceRawSha256 plus the ordered server-assigned candidate ids and positions. Editable draft content, decisions, and versions are covered by run version and later plan hash, not by changing the sealed candidate-universe hash.

event-repository returns events after an id and emits STREAM_RESET when the requested cursor is older than the retained minimum. Cleanup removes events only after 24 hours and never during an active operation.

- [ ] **Step 6: Verify green**

Run:

~~~bash
npm run test:integration -- extraction-repository
npm run typecheck
~~~

Expected: repository, uniqueness, version, state, and event retention tests pass.

- [ ] **Step 7: Commit**

~~~bash
git add src/server/db src/shared/domain/workflow.ts tests/integration/extraction-repository.test.ts
git commit -m "feat: persist extraction drafts and decisions"
~~~

### Task 2: Redact model input and call one OpenAI-compatible endpoint

**Files:**
- Create: src/server/ai/redaction.ts
- Create: src/server/ai/client.ts
- Create: src/server/ai/model-config.ts
- Create: tests/fixtures/fake-openai-server.ts
- Test: tests/unit/redaction.test.ts
- Test: tests/integration/ai-client.test.ts

- [ ] **Step 1: Write failing redaction tests**

Input must remove:

- URL query values named token, key, api_key, signature, access_token;
- Authorization and Cookie header values;
- explicit sk-style API keys;
- /Users/ao absolute paths.

Assert ordinary Chinese content, source URLs without sensitive query values, headings, and paragraph order remain. Redaction output returns stable paragraph block ids, original block byte ranges, redacted block text, count, byte length, and SHA-256.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:unit -- redaction
~~~

Expected: the suite loads and fails because sensitive values remain or ordinary source content is damaged. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement deterministic redaction**

Split the source into stable ordered blocks p0001, p0002, and so on before applying ordered, named replacement rules. Use markers such as [REDACTED_URL_SECRET] and [REDACTED_LOCAL_PATH]. AI evidence addresses blockId plus offsets inside the redacted block; the UI resolves blockId to the original source block without trusting changed global offsets. Never log the input text or persist the full redacted blocks.

- [ ] **Step 4: Write the failing compatible-client test**

Start tests/fixtures/fake-openai-server.ts on a random loopback port and assert the actual HTTP request:

~~~ts
const client = createCompatibleClient({
  baseURL: fakeServer.baseURL + '/v1/',
  model: 'test-model',
  apiKey: 'test-secret'
});
expect(request.url).toBe(fakeServer.baseURL + '/v1/chat/completions');
expect(request.headers.authorization).toBe('[redacted-in-test-observer]');
expect(body.model).toBe('test-model');
expect(body.response_format).toEqual({ type: 'json_object' });
~~~

Assert timeout, 429, non-JSON, missing choices, and aborted client requests map to stable errors and leave no candidate rows.

- [ ] **Step 5: Implement the client**

client.ts accepts baseURL, model, apiKey, timeoutMs, and an injected fetch. It normalizes one trailing slash and appends chat/completions without forcing a second v1 segment. It constructs exactly one request, uses AbortController, caps response bytes, and returns the assistant content string. It has no VaultGateway or filesystem dependency. model-config.ts requires HTTPS except for an explicit loopback test server under NODE_ENV=test. Integration tests use the real loopback fake server; a fetch spy is limited to unit-level header redaction checks.

- [ ] **Step 6: Verify green and commit**

Run:

~~~bash
npm run test:unit -- redaction
npm run test:integration -- ai-client
npm run typecheck
git add src/server/ai tests
git commit -m "feat: add redacted OpenAI-compatible model client"
~~~

Expected: all redaction and client error tests pass before commit.

### Task 3: Validate briefing and knowledge candidates before persistence

**Files:**
- Create: src/server/ai/schemas.ts
- Create: src/server/ai/prompts.ts
- Create: src/server/ai/orchestrator.ts
- Create: src/server/rules/candidate-validator.ts
- Test: tests/unit/candidate-validator.test.ts
- Test: tests/integration/ai-orchestrator.test.ts

- [ ] **Step 1: Write failing schema and rule tests**

Assert:

- 未看 requires a 3–6 sentence summary, key points, usefulness, and optional caution;
- 已看 may omit MaterialBriefing but still records the reading judgment;
- knowledge type is an exact enum;
- keywords contain 3–6 short strings;
- suggestedPath begins 02知识库/ and maps to an existing allowed route;
- topics contain only real topic nodes or become empty;
- conclusion and body are non-empty;
- evidence blockId exists, offsets fall inside that redacted block, and excerptHash matches;
- model-supplied sourceType, usageStatus, dates, or arbitrary YAML are ignored;
- invalid model output creates a retryable operation error and zero candidates.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:unit -- candidate-validator
npm run test:integration -- ai-orchestrator
~~~

Expected: both suites load and fail at structured-output, evidence, path, or all-or-nothing persistence assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement strict schemas**

Use Zod strict objects so unknown keys fail. Candidate output contains only the fields in CandidateDraft except id, runId, decision, and version. The server adds those fields.

MaterialBriefing summary uses an array of 3–6 sentences, not one unrestricted blob. Caution is absent when there is no evidence, controversy, or boundary concern.

- [ ] **Step 4: Implement the prompt builder**

prompts.ts receives:

~~~ts
type ExtractionPromptInput = {
  readingState: '已看' | '未看';
  sourcePath: string;
  redactedBlocks: ReadonlyArray<{ blockId: string; text: string }>;
  ruleExcerpt: string;
  nearbyKnowledgeCards: ReadonlyArray<{
    path: string;
    title: string;
    usageStatus: string;
    recallFields: Record<string, unknown>;
  }>;
};
~~~

The ruleExcerpt comes from the fingerprinted RuleBundle, not a browser-supplied string. The prompt instructs the model that this is 提炼 only, not 入库; no file is created; ordinary summaries are not knowledge; suggested paths and matches are proposals; and every candidate needs source evidence. A stale rule-bundle fingerprint blocks preview and generation with a visible compatibility reason.

Only the selected source and a small top-ranked YAML-card set are sent. Do not send knowledge bodies, operation history, attachments, or the entire vault.

- [ ] **Step 5: Implement orchestrator validation**

The orchestrator redacts, records model metadata, calls the client, parses JSON once, validates the entire result, runs deterministic rule checks, and then seals candidates in one transaction. Partial candidate persistence is forbidden.

- [ ] **Step 6: Verify green and commit**

Run:

~~~bash
npm run test:unit -- candidate-validator
npm run test:integration -- ai-orchestrator
npm run typecheck
git add src/server/ai src/server/rules/candidate-validator.ts tests
git commit -m "feat: validate structured extraction candidates"
~~~

### Task 4: Implement extraction lifecycle and historical partial recovery

**Files:**
- Create: src/server/workflow/extraction-service.ts
- Create: src/server/workflow/knowledge-match-service.ts
- Test: tests/integration/extraction-service.test.ts
- Test: tests/integration/historical-partial-recovery.test.ts

- [ ] **Step 1: Write failing lifecycle tests**

Cover these exact cases:

1. 未提炼 with no run creates one run.
2. Duplicate click returns the same run.
3. Matching active hash resumes.
4. Source hash change invalidates the old run and returns VERSION_CONFLICT.
5. 部分入库 with no local run sets recoveryMode=historical_partial.
6. Historical recovery displays the existing 生成知识 as a read-only dedupe baseline.
7. Existing generated links are never overwritten or removed.
8. Candidate matches search title and YAML recall fields only.
9. All candidates decided changes the run to ready_to_plan.
10. Zero accepted candidates still changes the run to ready_to_plan.
11. Any candidate edit or decision increments run version.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:integration -- extraction-service historical-partial
~~~

Expected: both suites load and fail at lifecycle, dedupe baseline, or historical-recovery assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement the lifecycle**

ExtractionService always rereads the source through VaultGateway before start/resume. It verifies 类型: 原始资料 and status 未提炼 or 部分入库. It never writes the source.

Historical partial recovery returns this explicit warning:

~~~text
历史部分入库：旧候选与旧决策无法恢复。本轮将保留现有生成知识，并只审阅重新识别的未覆盖候选。
~~~

knowledge-match-service ranks only indexed knowledge cards and returns candidate path, usage status, overlap reasons, and suggested disposition. It never opens knowledge bodies automatically.

- [ ] **Step 4: Verify green and commit**

Run:

~~~bash
npm run test:integration -- extraction-service historical-partial
npm run typecheck
git add src/server/workflow tests/integration
git commit -m "feat: manage extraction and legacy partial recovery"
~~~

### Task 5: Expose extraction, candidate, and SSE APIs

**Files:**
- Create: src/server/api/routes/extraction-runs.ts
- Create: src/server/api/routes/extraction-previews.ts
- Create: src/server/api/routes/candidates.ts
- Create: src/server/api/routes/events.ts
- Create: src/server/events/sse.ts
- Modify: src/shared/api/schemas.ts
- Modify: src/server/app.ts
- Test: tests/integration/extraction-api.test.ts
- Test: tests/integration/sse-resume.test.ts

- [ ] **Step 1: Write failing API tests**

Assert:

- POST /api/v1/extraction-runs requires materialPath, expectedSourceHash, readingState, CSRF, and idempotency key;
- POST /api/v1/extraction-previews returns model host/name, redaction count, byte count, redacted sending preview, selected context-card titles, and previewHash without calling the model;
- POST /api/v1/extraction-runs requires the current previewHash so a changed source cannot be sent from a stale preview;
- GET /api/v1/extraction-runs/:id returns briefing, acknowledgement, candidates, matches, run version, and recovery mode;
- PATCH /api/v1/candidates/:id requires expectedDraftVersion;
- stale edit returns VERSION_CONFLICT;
- completing review with pending candidates returns SCHEMA_INVALID;
- Last-Event-ID resumes at the next event;
- expired cursor emits stream_reset and the extraction snapshot URL;
- SSE token never appears in the URL.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:integration -- extraction-api sse-resume
~~~

Expected: both suites load and fail at versioned route, conflict, resume, or stream-reset assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement routes and SSE**

Routes call ExtractionService only; they do not access SQLite or VaultGateway directly. Extraction preview rereads and redacts the source but does not call the model or persist the full preview. Candidate edit parses a full candidate draft plus a decision and returns the new candidate and run versions.

SSE emits:

~~~text
id: 42
event: candidate_progress
data: {"operationId":"...","completed":2,"total":7}
~~~

On reset, emit event stream_reset with a stable snapshot route. Heartbeats contain no data and do not consume persisted event ids.

- [ ] **Step 4: Verify green and commit**

Run:

~~~bash
npm run test:integration -- extraction-api sse-resume
npm run typecheck
git add src/server/api src/server/events src/shared/api src/server/app.ts tests
git commit -m "feat: expose extraction workflow APIs"
~~~

### Task 6: Build the three-column extraction workbench

**Files:**
- Create: src/client/pages/ExtractionWorkbenchPage.tsx
- Create: src/client/components/extraction/ReadingStateGate.tsx
- Create: src/client/components/extraction/ModelInputPreview.tsx
- Create: src/client/components/extraction/MaterialBriefingPanel.tsx
- Create: src/client/components/extraction/SourceReader.tsx
- Create: src/client/components/extraction/CandidateList.tsx
- Create: src/client/components/extraction/CandidateEditor.tsx
- Create: src/client/components/extraction/KnowledgeMatches.tsx
- Create: src/client/styles/extraction.css
- Modify: src/client/pages/OperationsPage.tsx
- Modify: src/client/pages/ConnectionsPage.tsx
- Test: tests/component/extraction-workbench.test.tsx

- [ ] **Step 1: Write failing workbench tests**

Assert:

- no evidence defaults the gate to 未看;
- the user can explicitly choose 已看 or 按未看处理;
- after the choice, ModelInputPreview displays model destination, redaction count, byte count, redacted content, and context-card titles before the generate command;
- changing source hash invalidates the previewHash and prevents generation;
- the page always displays 阅读状态判断：已看 or 阅读状态判断：未看;
- 未看 hides candidate review until the briefing is acknowledged;
- 已看 shows candidates directly;
- source text is selectable, searchable, and never editable;
- candidate list has pending, accepted, and rejected labels;
- editor includes title, type, path, topics, keywords, scenarios, conclusion, points, boundary, body, value, and evidence;
- invalid edits cannot be accepted;
- match cards show usage status and overlap reason;
- a pending candidate disables 进入入库确认;
- all rejected still enables the zero-knowledge confirmation route;
- refresh restores briefing acknowledgement and decisions.

- [ ] **Step 2: Run and verify red**

Run:

~~~bash
npm run test:component -- extraction-workbench
~~~

Expected: the suite loads and fails at reading-state, briefing gate, candidate, or persistence assertions. Module resolution and type errors do not count as RED.

- [ ] **Step 3: Implement the reading gate and briefing**

ReadingStateGate precedes run creation. It explains why 未看 is the default. MaterialBriefingPanel renders 3–6 summary sentences, main points, usefulness, and optional caution. The acknowledgement is a persisted command, not browser-only state.

ModelInputPreview calls the preview route, renders only redacted content, and requires an explicit 生成候选 button. The extraction run command carries previewHash. Cancel returns to the queue without a model request.

- [ ] **Step 4: Implement source and candidate panels**

Use a responsive desktop grid with source, candidate list, and editor. At 1280 px all three remain usable; source and editor may scroll independently. SourceReader assigns the same stable paragraph block ids used by redaction so an evidence click scrolls to the correct original block. Do not use glass blur behind long-form source text.

Candidate decisions remain reversible until a write batch exists. Every save sends expectedDraftVersion and replaces local state only with the validated response.

OperationsPage lists extraction start, model status, candidate edits, decisions, retry, and ready_to_plan events by operationId without prompt or source body. ConnectionsPage shows configured/unconfigured model state, selected model name, and last request failure without the API key.

- [ ] **Step 5: Verify green and commit**

Run:

~~~bash
npm run test:component -- extraction-workbench
npm run typecheck
git add src/client/pages/ExtractionWorkbenchPage.tsx src/client/components/extraction src/client/styles tests/component
git commit -m "feat: add the extraction review workbench"
~~~

### Task 7: Verify a complete draft-only journey

**Files:**
- Create: tests/e2e/extraction-draft-flow.spec.ts
- Create: tests/e2e/historical-partial.spec.ts
- Modify: src/client/pages/DashboardPage.tsx
- Modify: src/client/pages/MaterialQueuePage.tsx

- [ ] **Step 1: Add E2E fixtures**

Create a fake material set with:

- one 未提炼 source;
- one 部分入库 source with a matching active run;
- one 部分入库 source with no local run and two existing 生成知识 links;
- one invalid historical type excluded by schema.

Fake AI returns one valid 未看 briefing and three candidates, including one match to 已优化.

- [ ] **Step 2: Write the draft-only journeys**

Journey A:

~~~text
Dashboard -> 开始提炼 -> 未看 -> acknowledge briefing
-> edit candidate -> accept one -> reject two
-> refresh -> decisions remain -> ready_to_plan
~~~

Journey B:

~~~text
Queue -> 恢复提炼 -> explicit historical warning
-> existing generated links visible -> recovered candidates reviewed
-> existing links unchanged in every API snapshot
~~~

Assert no fake or real VaultGateway mutation method is called.

- [ ] **Step 3: Run and verify red, then connect the CTA**

Run before wiring:

~~~bash
npm run test:e2e -- extraction-draft-flow historical-partial
~~~

Expected: the suite loads and fails at the start, resume, or recover CTA navigation assertion. Module resolution and type errors do not count as RED.

Wire 开始提炼, 继续审阅, and 恢复提炼 to the correct reading gate or existing run. Keep final write confirmation visibly unavailable until Phase 3.

- [ ] **Step 4: Run Phase 2 verification**

Run:

~~~bash
npm run test:unit
npm run test:integration
npm run test:component
npm run test:e2e -- extraction-draft-flow historical-partial
npm run build
~~~

Expected: all draft journeys pass, build exits 0, and the VaultGateway mutation spy count is zero.

- [ ] **Step 5: Commit**

~~~bash
git add src/client/pages tests/e2e
git commit -m "test: verify the draft-only extraction journey"
~~~

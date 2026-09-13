# Personal App: DeepSeek configuration and candidate preview

## Approved scope

The user approved the next step after archiving a real clip: configure DeepSeek inside the personal App, explicitly extract one archived material, and view durable knowledge candidates. Formal knowledge ingestion remains a separate, unimplemented step. Keep the existing dark interface and left navigation.

This is a bounded personal-App slice, not execution of the entire older Phase 3 plan (no candidate editing/acceptance, multi-provider settings, SSE, batch ingestion, or unattended AI). Existing intake and formal write gates stay unchanged. A source-and-rule-bound confirmation authorizes only one outbound extraction; it is not an approval for formal vault writes.

## Design and acceptance

- Credentials: one DeepSeek API key, encrypted using Electron safeStorage and saved outside the vault with private permissions. No plaintext fallback, renderer storage, returned key, or raw provider error logging. Saving/deleting configuration never calls the provider.
- Provider: fixed HTTPS DeepSeek host; default `deepseek-v4-flash`, non-streaming JSON output, thinking disabled, bounded request/response and timeout. No tools, redirects, automatic retries, remote image downloads, or unrelated vault documents sent.
- Consent: preview the exact outbound messages locally, disclose source plus rules/directory context and possible provider fees. Default reading state 未看; changing the source/reading state/config invalidates the preview. Recheck source and rule fingerprints before sending. Only a separate explicit confirmation sends it.
- Candidates: structured JSON validated before saving; title, knowledge type, suggested existing directory, empty topics in this slice, core content and value. For 未看, include a 3–6 sentence introduction, key points, usefulness and optional evidence/boundary caution. Output is unverified AI candidate content, not formal knowledge.
- Persistence: App-local SQLite, isolated by vault. Persist generating/result/failure state, source and rule fingerprints; survive navigation/restart without automatic reissue. A interrupted run becomes failed/interrupted; duplicate start does not charge twice. Keep prior candidates available. Cancel aborts the outgoing request but cannot promise provider billing cancellation.
- UI: settings key form; homepage/queue entry; preflight preview; progress/cancel/error/empty/result states; reopen saved results. No enabled ingestion button and no source status update. Original Markdown and knowledge files are untouched throughout.
- Safety: retain loopback Host/Origin/session/CSRF protection. Model output and original text are untrusted data, rendered safely. Credentials/service absent means feature unavailable, not fake success.

## Execution checklist

- [x] Inspect current App, vault rules, existing plans and official API docs; baseline unit tests (587 passing).
- [x] Backend contract/security/provider/storage/service: write failing tests, implement smallest passing slice, inspect spec compliance then quality.
- [x] UI/API integration: failing component/client tests, implement using existing components/styles, verify native and narrow layouts.
- [x] Full regression/build and packaged App smoke; verify fixtures never touch the real vault or real provider.
- [x] Update README and current vault handoff; hand off App settings for the user's own key. A real paid call is not claimed until the user performs it.

## Implementation and verification notes

- Credentials port is injected by Electron; encrypted bytes live in `userData/model-credentials/deepseek-key.enc`. No plaintext fallback, environment-key import or remote configuration file.
- `/api/v1/deepseek` exposes only availability/configuration status; key save/clear are explicit protected POSTs. `/api/v1/extractions` exposes preview, start, cancellation and persisted results. Exact outgoing preview is separate from sending.
- `008_personal_extraction.sql` adds `personal_extraction_runs`, preserving the older reserved migration numbers and old extraction table. Source and rule fingerprints, consumed preview tokens, status and validated result are durable per vault, outside the source folders.
- One request per preview token; same source cannot generate twice concurrently. Cancellation/timeout/restart never automatically reissue. Candidate generation does not use or open the formal knowledge write gate.
- Source cap 100,000 bytes; no silent truncation. At most 12 candidates, only existing knowledge directories, empty topics. Model response is bounded and strictly validated; empty candidate lists are valid. Provider errors are sanitized and credentials never returned.
- Homepage keeps all unrefined cards visible but disables extraction for unarchived sources with an inbox instruction. Queue/history provides a permanent return path to recent saved results, even when the source disappears from the queue.
- Independent backend spec review passed (38 unit + 23 integration checks). UI spec review found an unarchived-card action; regression first failed, then the per-card guard passed. No unrelated cleanup or formal vault writes.
- Final regression: 625 unit tests, 175 integration tests, 220 component tests, 12 personal archive native contracts and 46 personal archive recovery/service tests passed. Full desktop build and type checks passed. Development and packaged Electron whole flows both passed; all 8 Electron tests passed in 58 seconds. Packaged settings, candidates and 720px layout were visually checked; no horizontal overflow.
- Independent UI spec re-review passed after the per-card fix. Final quality review found no critical or important code issue; its minor normal-shutdown-versus-crash wording correction was applied to README. No merge/commit or unrelated dirty-worktree cleanup performed.
- Repackaged using the verified local Electron 44.1.0 cache, then reopened the actual App. Live read-only checks: filesystem vault ready, index v9 ready, DeepSeek safe storage available but no key configured, extraction history empty, formal write gate still blocked, 21 pre-existing schema issues unchanged. App was left at its native Settings page (`127.0.0.1:62710/settings` for this launch, not the old browser runtime).
- Before and after packaging/relaunch, the sorted per-file SHA-256 aggregate over `01图书馆` and `02知识库` was identical: `4ae9fc9c0ef384e3b176f7dba04e2cec654a1f3f90964bcb5195c82c35bf2ed8`. No real key or paid provider call was used. User content and knowledge status remain unchanged.

The real archived material remains untouched. Automated Electron tests substitute the provider transport in the test process; they do not establish real DeepSeek credentials, network availability or model quality.

## Current official API references (checked 2026-09-06)

- [DeepSeek first API call](https://api-docs.deepseek.com/): supported text model names and fixed official endpoint.
- [JSON Output](https://api-docs.deepseek.com/guides/json_mode/): `response_format: {type: "json_object"}`, JSON instructions/example and bounded output; empty/truncated content must be treated as a failure.
- [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/): explicitly disable thinking for this bounded structured extraction.

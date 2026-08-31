# Obsidian Local REST API 5.1.0 contract status

Status as of 2026-08-31: **FORMAL WRITE GATE BLOCKED**.

No independent sentinel-marked test vault was available when this harness was implemented. The executable write, external-mutation, cleanup, and restart probes have not been run. OpenAPI declarations are design inputs only and do not count as passed capability evidence.

Missing contract context is a hard failure (`CONTRACT_CONTEXT_MISSING`), not a skipped or passing test. Each persisted profile and its non-secret Markdown report are immutable revision files under `APP_DATA_DIR/contract-profiles/`. An fsynced fail-closed activation marker precedes the atomic `current.json` switch; loaders reject every profile while that marker exists, so an indeterminate pointer commit cannot revive an older passing gate. The runtime gate loads only the exact guarded revision named by the pointer. Reports derive each capability state from the latest executable evidence: no evidence is `UNVERIFIED`, explicit negative evidence is `FAILED`, and only passed evidence with the operation-specific primitive is `PASSED`. They include sanitized reason codes but never paths, bodies, or secrets.

## Current evidence

| Capability | Status | Current evidence |
|---|---|---|
| safeRead | UNVERIFIED in an independent test vault | A separate read-only smoke against the formal vault observed the plugin fingerprint and response shapes listed below. It did not establish test-fixture byte fidelity. |
| safeReplace | UNVERIFIED | PATCH declares an optional `If-Match`; no executable independent-vault probe has run. |
| safeCreate | UNVERIFIED | PUT with `Reject-If-Content-Preexists` and COPY with `Allow-Overwrite:false` are probed separately for create, collision, and raw reread behavior. Neither declaration is assumed atomic. |
| safeRestore | UNVERIFIED | Requires a successful conditional replace, exact raw reread, and conditional restore probe. |
| safeDelete | UNVERIFIED | DELETE declares no conditional token. A pre-read followed by unconditional DELETE is not accepted as safe. |
| rereadVerified | UNVERIFIED | Every successful mutation must be followed by an exact raw-byte/hash reread. |
| externalMutationObservation | UNVERIFIED | Create, modify, rename, and delete observation must pass inside one guarded run sandbox. |
| restartPersistence | UNVERIFIED | The prepare/restart/verify sequence has not run. |
| formalWriteGate | **BLOCKED** | All rows above must pass for the exact fingerprint/OpenAPI profile key. |

Unsupported behavior is a valid probe result. The probe persists `failed` evidence and may finish successfully while the formal write gate remains blocked. Assertions must not be weakened to force a passing profile.

## Isolation requirements

The operator must open an independent Obsidian vault before any write or restart command. That vault, the formal vault, the source checkout, and application-data directory must all exist, resolve through symlinks to pairwise distinct and non-contained roots, and the independent vault must contain `__XIAOZHAO_TEST_VAULT__` with the exact trimmed value `xiaozhao-contract-v1` both on disk and through Local REST.

Vault mutation is armed only when `ALLOW_OBSIDIAN_CONTRACT_WRITE` equals exactly `1`. Test files are restricted to a fresh ULID below one of these two contract areas:

- `01图书馆/来自其他/__xiaozhao_contract__/`
- `02知识库/99其他/__xiaozhao_contract__/`

Cleanup may target only that run and may use only non-permanent trash behavior. If safe cleanup is not established, the harness leaves the sandbox for manual cleanup and records a sanitized reason code.

Restart verification is run-bound. Before any test-vault mutation, the current profile is CAS-updated to `restartPersistence=unverified` and a 0600 `preparing` WAL is fsynced with the run identity and expected hash. REST observation advances it to `prepared`. After the human restart, exact raw/version evidence first advances the WAL to `restart-verified` with a fixed timestamp and intended profile revision; only then may that exact profile revision be activated. A mismatch first advances the same WAL to terminal `restart-failed` and only then CAS-writes failed profile evidence. That run is never reread or reactivated, even if its bytes later reappear or another probe resets restart evidence; another verification requires a new run. If the failed-profile CAS conflicts after the terminal commit, the terminal locator remains a stable manual fail-closed blocker (`RESTART_TERMINAL_FAILURE_RECORDED`) rather than rebasing stale failure evidence. A newer blocked profile can be rebased only while its latest restart evidence remains explicitly unverified, so capability revocations are preserved and restart failures are never erased.

A failed or unverified cleanup leaves the run locator active for retry/manual cleanup. Cleanup failures first fsync a run-bound locator and then CAS-write `FAILED` cleanup evidence into the profile/report while preserving the passed restart evidence. Retry accepts only cleanup-only evolution that normalizes back to the exact intended restart revision; unrelated profile changes and later restart failures remain blocked. Cleanup passes only for one uninterrupted exact pre-read, non-permanent DELETE 2xx, and subsequent 404 sequence; an initially missing target remains failed/manual.

Store lock files are deliberately fail-closed. An abrupt process death may leave `store.lock` or `restart-pending.lock`; the harness reports a stable profile/pending write failure and requires manual operator inspection rather than guessing that the lock is stale. It does not automatically reclaim PID-based leases.

Required runtime context is supplied through `OBSIDIAN_API_URL`, `OBSIDIAN_API_KEY`, `CONTRACT_TEST_VAULT_ROOT`, `VAULT_REAL_ROOT`, `CONTRACT_SOURCE_ROOT`, and `APP_DATA_DIR`. The read fixture run is selected by `OBSIDIAN_CONTRACT_FIXTURE_RUN_ID`. Secrets are never stored in profiles or printed by the gate.

## Commands

Read-only fixture probe, after the independent vault and fixture exist:

```bash
npm run test:contract:obsidian:probe -- read
```

Guarded write probe, only after the independent test vault is open and verified:

```bash
ALLOW_OBSIDIAN_CONTRACT_WRITE=1 npm run test:contract:obsidian:probe
```

The no-filter command runs the read contract in its own process first and starts the guarded write process only after read exits successfully. A read or runner failure stops the sequence. It never runs either restart phase. `-- write` selects only the guarded write file.

Two-phase restart probe:

```bash
ALLOW_OBSIDIAN_CONTRACT_WRITE=1 npm run test:contract:obsidian:restart:prepare
# Restart Obsidian manually.
ALLOW_OBSIDIAN_CONTRACT_WRITE=1 npm run test:contract:obsidian:restart:verify
```

The runtime write gate requires the exact expected profile key in `OBSIDIAN_CONTRACT_PROFILE_KEY`:

```bash
npm run gate:write-capability
```

Exit `0` means every executable capability and restart persistence passed for that exact key. Exit `1` means blocked or unavailable; CLI output contains missing capability names only.

## Separate formal-vault read-only smoke

A prior read-only smoke against the formal vault observed:

- plugin id `obsidian-local-rest-api`, plugin version `5.1.0`;
- Obsidian version `1.13.7`;
- directory payload shape `{files: string[]}`;
- document-map `version` is the PATCH CAS token and differs from the HTTP ETag.

This smoke made no vault mutation and does not pass any write, cleanup, external-observation, or restart capability.

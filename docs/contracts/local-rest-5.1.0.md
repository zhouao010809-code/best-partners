# Obsidian Local REST API 5.1.0 contract status

Status as of 2026-08-31: **FORMAL WRITE GATE BLOCKED**.

No independent sentinel-marked test vault was available when this harness was implemented. The executable write, external-mutation, cleanup, and restart probes have not been run. OpenAPI declarations are design inputs only and do not count as passed capability evidence.

## Current evidence

| Capability | Status | Current evidence |
|---|---|---|
| safeRead | UNVERIFIED in an independent test vault | A separate read-only smoke against the formal vault observed the plugin fingerprint and response shapes listed below. It did not establish test-fixture byte fidelity. |
| safeReplace | UNVERIFIED | PATCH declares an optional `If-Match`; no executable independent-vault probe has run. |
| safeCreate | UNVERIFIED | COPY with `Allow-Overwrite:false` is a candidate only; PUT is not assumed to be atomic create-if-absent. |
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

Required runtime context is supplied through `OBSIDIAN_API_URL`, `OBSIDIAN_API_KEY`, `CONTRACT_TEST_VAULT_ROOT`, `VAULT_REAL_ROOT`, `CONTRACT_SOURCE_ROOT`, and `APP_DATA_DIR`. The read fixture run is selected by `OBSIDIAN_CONTRACT_FIXTURE_RUN_ID`. Secrets are never stored in profiles or printed by the gate.

## Commands

Read-only fixture probe, after the independent vault and fixture exist:

```bash
npm run test:contract:obsidian:probe -- read.contract
```

Guarded write probe, only after the independent test vault is open and verified:

```bash
ALLOW_OBSIDIAN_CONTRACT_WRITE=1 npm run test:contract:obsidian:probe -- write-gate.contract
```

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

Exit `0` means every executable capability and restart persistence passed for that exact key. Exit `1` means blocked or unavailable; output contains capability names and reason codes only.

## Separate formal-vault read-only smoke

A prior read-only smoke against the formal vault observed:

- plugin id `obsidian-local-rest-api`, plugin version `5.1.0`;
- Obsidian version `1.13.7`;
- directory payload shape `{files: string[]}`;
- document-map `version` is the PATCH CAS token and differs from the HTTP ETag.

This smoke made no vault mutation and does not pass any write, cleanup, external-observation, or restart capability.

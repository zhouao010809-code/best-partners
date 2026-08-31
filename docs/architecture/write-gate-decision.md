# Phase 0 formal write capability checkpoint

Recorded on 2026-08-31. This checkpoint distinguishes local harness verification from capabilities observed against an isolated Obsidian fixture.

| Gate | Status | Evidence | Consequence |
|---|---|---|---|
| G0 Isolation | BLOCKED | No separately approved, sentinel-marked independent test vault was available. | No executable contract write probe was armed. |
| G1 REST read | UNVERIFIED | A read-only smoke against the formal vault observed the Local REST fingerprint and response shapes, but that is not an independent fixture byte-fidelity result. | Do not treat read fidelity as passed contract evidence. |
| G2 REST write CAS | BLOCKED | Executable create, replace, restore, delete, cleanup, external-mutation, and restart-persistence probes were not run. | Keep real-vault writes disabled. |

Local unit and integration tests validate that the runtime gate fails closed for a missing or mismatched exact profile, missing executable evidence, disabled configuration, database recovery-only mode, and pending recovery data. Those deterministic tests do not promote G0, G1, or G2.

The health snapshot is an instantaneous observation, not mutation authorization. A Phase 3 coordinator must re-evaluate recovery and write predicates under its write/recovery lock immediately before mutation.

```text
G2 BLOCKED
Phase 1 and Phase 2 may continue.
Phase 3 real writes require a separately approved companion Obsidian plugin gateway or remain draft-only.
```

An unguarded direct-filesystem writer is not an approved fallback.

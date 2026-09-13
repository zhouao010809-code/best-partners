import { z } from 'zod';
import { candidateDraftSchema, reviewCandidateSchema, type ReviewCandidate } from '../../../shared/api/ingestion.js';

export const candidateContentIdentity = (value: ReviewCandidate) => JSON.stringify({ draft: value.draft, decision: value.decision, target: value.target });
// In-progress text must remain recoverable even when it exceeds the API limits.
const localCandidateSchema = reviewCandidateSchema.extend({ draft: candidateDraftSchema.extend({
  topics: z.array(z.string()), draft: z.strictObject({ keywords: z.array(z.string()), scenarios: z.array(z.string()),
    conclusion: z.string(), keyPoints: z.array(z.string()), boundary: z.string(), quotes: z.array(z.string()), summaries: z.array(z.string()) })
}) });
const storedDraftSchema = z.strictObject({ value: localCandidateSchema, updatedAt: z.number(), revision: z.uuid() });
export type StoredCandidateDraft = { key: string; value: ReviewCandidate; updatedAt: number };

/** Each mounted editor owns its payload. A copied session reference only imports a snapshot. */
export function createCandidateDraftStore(runId: string) {
  const owners = new Map<string, string>();
  let durable: Storage | undefined; let session: Storage | undefined;
  try { durable = localStorage; } catch { /* The editor reports a failed write. */ }
  try { session = sessionStorage; } catch { /* Persistent copies can still be recovered explicitly. */ }
  const legacyKey = (id: string) => `brain-ingestion-draft:${runId}:${id}`;
  const ownKey = (id: string) => {
    if (!owners.has(id)) owners.set(id, crypto.randomUUID());
    return `${legacyKey(id)}:${owners.get(id)!}`;
  };
  const referenceKey = (id: string) => `brain-ingestion-draft-ref:${runId}:${id}`;
  const acknowledgementKey = (key: string) => `brain-ingestion-draft-synced:${key}`;
  const legacyImports = new Map<string, string>();
  return {
    read(candidate: ReviewCandidate): { selected?: StoredCandidateDraft; copies: StoredCandidateDraft[] } {
      const copies: StoredCandidateDraft[] = [];
      let reference: string | null = null;
      try { reference = session?.getItem(referenceKey(candidate.id)) ?? null; } catch { /* Offer saved copies below. */ }
      if (!durable) return { copies };
      const base = legacyKey(candidate.id);
      const add = (record: StoredCandidateDraft) => {
        if (record.value.id === candidate.id && record.value.state === 'pending'
          && candidateContentIdentity(record.value) !== candidateContentIdentity(candidate)) copies.push(record);
      };
      try {
        const raw = durable.getItem(base);
        if (raw) {
          const parsed = localCandidateSchema.safeParse(JSON.parse(raw));
          if (parsed.success) { add({ key: base, value: parsed.data, updatedAt: 0 }); legacyImports.set(candidate.id, raw); }
        }
      } catch { /* Malformed legacy data must not hide independent copies. */ }
      try {
        for (let index = 0; index < durable.length; index++) {
          const key = durable.key(index);
          if (!key?.startsWith(`${base}:`)) continue;
          try {
            const raw = durable.getItem(key);
            if (!raw || durable.getItem(acknowledgementKey(key)) === raw) continue;
            const parsed = storedDraftSchema.safeParse(JSON.parse(raw));
            if (parsed.success) add({ key, ...parsed.data });
          } catch { /* An invalid copy must not hide other valid drafts. */ }
        }
      } catch { /* Existing in-memory edits remain available if storage cannot be read. */ }
      copies.sort((a, b) => b.updatedAt - a.updatedAt);
      const selected = copies.find(copy => copy.key === reference) ?? (reference === null ? copies.find(copy => copy.key === base) : undefined);
      const seen = new Set<string>();
      const distinct = copies.filter(copy => { const identity = candidateContentIdentity(copy.value); if (seen.has(identity)) return false; seen.add(identity); return true; });
      return { ...(selected ? { selected } : {}), copies: distinct };
    },
    write(value: ReviewCandidate): void {
      if (!durable) throw new Error('Draft storage is unavailable');
      const key = ownKey(value.id);
      durable.setItem(key, JSON.stringify({ value, updatedAt: Date.now(), revision: crypto.randomUUID() }));
      try { session?.setItem(referenceKey(value.id), key); } catch { /* The persistent copy remains discoverable. */ }
      // Migrate a legacy shared payload only after its independent replacement is durable.
      const legacy = legacyImports.get(value.id);
      if (legacy !== undefined) {
        try { if (durable.getItem(legacyKey(value.id)) === legacy) durable.removeItem(legacyKey(value.id)); } catch { /* Keep the recovery copy. */ }
        legacyImports.delete(value.id);
      }
    },
    fork(id: string): void { owners.set(id, crypto.randomUUID()); },
    clear(saved: ReviewCandidate): void {
      const id = saved.id;
      if (durable) {
        // A reload may have imported a still-live editor's copy. Acknowledging its
        // exact bytes avoids deleting that payload; a later write has a new revision.
        let keys: (string | null)[] = [];
        try { keys = Array.from({ length: durable.length }, (_, index) => durable!.key(index)); } catch { /* Keep recovery copies if storage becomes unavailable. */ }
        for (const key of keys) {
          if (!key?.startsWith(`${legacyKey(id)}:`) || key === ownKey(id)) continue;
          try {
            const raw = durable.getItem(key);
            const parsed = storedDraftSchema.safeParse(JSON.parse(raw ?? 'null'));
            if (raw && parsed.success && parsed.data.value.version <= saved.version
              && candidateContentIdentity(parsed.data.value) === candidateContentIdentity(saved)) durable.setItem(acknowledgementKey(key), raw);
          } catch { /* Keeping an extra recovery copy is safer than removing it. */ }
        }
      }
      try { durable?.removeItem(ownKey(id)); } catch { /* The server copy remains authoritative. */ }
      try { session?.setItem(referenceKey(id), 'saved'); } catch { /* Never remove another editor's payload. */ }
    }
  };
}

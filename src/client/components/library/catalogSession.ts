import { useEffect, useRef, useState } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';
import { z } from 'zod';

const sessionSchema = z.object({
  recent: z.object({ path: z.string().max(1024), title: z.string().max(1000), query: z.string().max(8192) }).optional(),
  listing: z.string().max(8192).optional(),
  layout: z.enum(['papers', 'compact']).optional(),
  open: z.boolean().optional(),
  positions: z.record(z.string(), z.number().finite().nonnegative()).optional(),
  loadedCounts: z.record(z.string(), z.number().int().nonnegative()).optional()
});
export type CatalogSession = z.infer<typeof sessionSchema>;
/** Navigation hints only; document contents and authoritative versions never enter this cache. */
export function readCatalogSession(key: string): CatalogSession {
  try { return sessionSchema.parse(JSON.parse(sessionStorage.getItem(key) ?? '{}')); } catch { return {}; }
}
export function updateCatalogSession(key: string, patch: Partial<CatalogSession>): void {
  try { sessionStorage.setItem(key, JSON.stringify({ ...readCatalogSession(key), ...patch })); } catch { /* Browsing works without session storage. */ }
}
export function catalogSessionKey(kind: 'library' | 'knowledge', vaultName: string): string {
  return `brain-catalog-session:${kind}:${vaultName}`;
}
export function rememberCatalogPosition(key: string, scope: string, position: number): void {
  const entries = Object.entries(readCatalogSession(key).positions ?? {}).filter(([name]) => name !== scope).slice(-49);
  updateCatalogSession(key, { positions: Object.fromEntries([...entries, [scope, Math.max(0, position)]]) });
}
export function rememberCatalogCount(key: string, scope: string, count: number): void {
  const entries = Object.entries(readCatalogSession(key).loadedCounts ?? {}).filter(([name]) => name !== scope).slice(-49);
  updateCatalogSession(key, { loadedCounts: Object.fromEntries([...entries, [scope, count]]) });
}

/** Restore only bare navigation entries; explicit links and browser history remain authoritative. */
export function useCatalogReturn(key: string, params: URLSearchParams, setParams: SetURLSearchParams): boolean {
  const [initial] = useState(() => params.size === 0 ? readCatalogSession(key).listing : undefined);
  const [ready, setReady] = useState(!initial);
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current) return;
    applied.current = true;
    if (initial) setParams(initial, { replace: true });
    setReady(true);
  }, [initial, setParams]);
  useEffect(() => {
    if (!ready) return;
    const listing = new URLSearchParams(params); listing.delete('path');
    updateCatalogSession(key, { listing: listing.toString() });
  }, [key, params, ready]);
  return ready;
}

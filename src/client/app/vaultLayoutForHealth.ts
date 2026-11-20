import { CURRENT_VAULT_LAYOUT, LEGACY_VAULT_LAYOUT } from '../../shared/domain/vault-layout.js';
import type { HealthSnapshot } from '../api/client.js';
import type { Resource } from './ConsoleRuntime.js';

export function vaultLayoutForHealth(health?: Resource<HealthSnapshot>) {
  const source = health && 'data' in health ? health.data?.vaultSource : undefined;
  return source?.status === 'ready' && source.layout === 'current' ? CURRENT_VAULT_LAYOUT : LEGACY_VAULT_LAYOUT;
}

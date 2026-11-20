import { AppError } from '../../shared/api/errors.js';
import { LEGACY_VAULT_LAYOUT, vaultLayoutForRuleFiles, type VaultLayout } from '../../shared/domain/vault-layout.js';
import type { NativeVaultReader } from './NativeReadVaultPort.js';

type Reader = Pick<NativeVaultReader, 'listDirectory' | 'assertDirectory' | 'assertFile'>;

export async function identifyVaultLayout(reader: Pick<Reader, 'listDirectory'>): Promise<VaultLayout> {
  try {
    const rules = await reader.listDirectory('00大脑规则');
    return vaultLayoutForRuleFiles(rules.filter(entry => entry.kind === 'file').map(entry => entry.name));
  } catch (error) {
    // Keep an existing gateway available to report missing rules via its health probe.
    if (error instanceof AppError && error.code === 'NOT_FOUND') return LEGACY_VAULT_LAYOUT;
    throw error;
  }
}

export async function detectVaultLayout(reader: Reader): Promise<VaultLayout> {
  const layout = await identifyVaultLayout(reader);
  for (const path of ['00大脑规则', '01图书馆', layout.knowledgeRoot, layout.outputRoot]) {
    await reader.assertDirectory(path);
  }
  if (layout.id === 'current') await reader.assertDirectory('02日记本');
  for (const path of layout.rulePaths) await reader.assertFile(path);
  return layout;
}

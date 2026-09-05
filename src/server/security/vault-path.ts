import { AppError, ErrorCode } from '../../shared/api/errors.js';
import { validateFilesystemPath } from '../vault/filesystem-path.js';

export function normalizeVaultPath(input: string, mode: 'read' | 'write'): string {
  const value = validateFilesystemPath(input);
  if (mode === 'write' && value.startsWith('00大脑规则/')) {
    throw new AppError(ErrorCode.PathNotAllowed, 'PATH_NOT_ALLOWED');
  }
  return value;
}

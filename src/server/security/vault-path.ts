import { AppError, ErrorCode } from '../../shared/api/errors.js';

const READ_ROOTS = ['00大脑规则/', '01图书馆/', '02知识库/'];
const WRITE_ROOTS = ['01图书馆/', '02知识库/'];

export function normalizeVaultPath(input: string, mode: 'read' | 'write'): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    throw new AppError(ErrorCode.PathNotAllowed, 'PATH_NOT_ALLOWED');
  }
  const value = decoded.normalize('NFC');
  if (
    value.length === 0
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes('\0')
    || value.split('/').some((part) => part === '..' || part === '.' || part.startsWith('.'))
    || /%[0-9a-f]{2}/i.test(value)
  ) {
    throw new AppError(ErrorCode.PathNotAllowed, 'PATH_NOT_ALLOWED');
  }
  const roots = mode === 'read' ? READ_ROOTS : WRITE_ROOTS;
  if (!roots.some((root) => value.startsWith(root))) {
    throw new AppError(ErrorCode.PathNotAllowed, 'PATH_NOT_ALLOWED');
  }
  return value;
}

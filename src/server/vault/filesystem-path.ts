import { AppError } from '../../shared/api/errors.js';

const READ_ROOTS = new Set(['00大脑规则', '01图书馆', '02知识库']);

function reject(): never {
  throw new AppError('PATH_NOT_ALLOWED', 'PATH_NOT_ALLOWED');
}

function validText(input: string): boolean {
  return input.length > 0 && Buffer.byteLength(input, 'utf8') <= 4096
    && !input.includes('\\') && !input.includes('\0')
    && Buffer.from(input, 'utf8').toString('utf8') === input;
}

/** Inputs are already decoded at the HTTP boundary; preserve filesystem identity. */
export function validateFilesystemPath(
  input: string,
  kind: 'file' | 'directory' | 'directory-check' = 'file'
): string {
  if (!validText(input)) reject();
  const parts = input.split('/');
  if (parts.some((part) => !part || part.startsWith('.') || Buffer.byteLength(part, 'utf8') > 255)) reject();
  if (kind === 'directory-check' && input === '03大讲堂') return input;
  if (!READ_ROOTS.has(parts[0]!) || (kind === 'file' && parts.length < 2)) reject();
  return input;
}

/** Only lexical checks; the helper establishes authority using directory descriptors. */
export function validateFilesystemRoot(input: string): string {
  if (!validText(input) || !input.startsWith('/') || input === '/') reject();
  if (input.slice(1).split('/').some((part) => !part || part === '.' || part === '..'
    || Buffer.byteLength(part, 'utf8') > 255)) reject();
  return input;
}

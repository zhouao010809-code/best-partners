import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKnowledgeNote } from '../src/server/rules/knowledge-schema.js';
import { parseLibraryNote } from '../src/server/rules/library-schema.js';
import {
  parseKnowledgeNoteForRead,
  parseLibraryNoteForRead
} from '../src/server/rules/read-compatible-notes.js';

const NOTE_ROOTS = [
  { directory: '01图书馆', kind: 'material' as const },
  { directory: '02知识库', kind: 'knowledge' as const }
];
const UNCLASSIFIED_FRONTMATTER_CODES = new Set([
  'FRONTMATTER_OPENING_DELIMITER_MISSING'
]);

export type VaultLintKind = 'material' | 'knowledge';
export type VaultLintSeverity = 'warning' | 'error';

export type VaultLintIssue = {
  readonly path: string;
  readonly kind: VaultLintKind;
  readonly severity: VaultLintSeverity;
  readonly code: string;
  readonly message: string;
  readonly field?: string;
};

export type VaultLintReport = {
  readonly root: string;
  readonly summary: {
    readonly files: number;
    readonly valid: number;
    readonly warnings: number;
    readonly errors: number;
  };
  readonly issues: readonly VaultLintIssue[];
};

export type VaultLintOptions = {
  readonly strictUntyped?: boolean;
};

async function collectMarkdownFiles(root: string, directory: string): Promise<string[]> {
  const start = join(root, directory);
  const result: string[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.waveform-cache') continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.md')) {
        result.push(path);
      }
    }
  }

  await visit(start);
  return result;
}

function issueFromParsed(
  path: string,
  kind: VaultLintKind,
  parsed: { readonly issues: readonly { readonly code: string; readonly message: string; readonly field?: string }[] },
  severity: VaultLintSeverity,
  code = parsed.issues[0]?.code ?? 'INVALID_NOTE'
): VaultLintIssue {
  const first = parsed.issues[0];
  return {
    path,
    kind,
    severity,
    code,
    message: first?.message ?? '笔记未通过格式校验。',
    ...(first?.field === undefined ? {} : { field: first.field })
  };
}

async function lintFile(root: string, absolutePath: string, kind: VaultLintKind, options: VaultLintOptions): Promise<VaultLintIssue | undefined> {
  const path = relative(root, absolutePath).split(sep).join('/');
  const bytes = await readFile(absolutePath);
  const strict = kind === 'material'
    ? parseLibraryNote(bytes, path)
    : parseKnowledgeNote(bytes, path);
  if (strict.record !== undefined) return undefined;

  const compatible = kind === 'material'
    ? parseLibraryNoteForRead(bytes, path)
    : parseKnowledgeNoteForRead(bytes, path);
  if (compatible.record !== undefined) {
    return issueFromParsed(path, kind, strict, 'warning', 'LEGACY_READ_COMPATIBLE');
  }

  const first = strict.issues[0];
  if (first?.code === 'FRONTMATTER_INVALID' && UNCLASSIFIED_FRONTMATTER_CODES.has(first.message)) {
    return issueFromParsed(path, kind, strict, options.strictUntyped === true ? 'error' : 'warning', 'UNCLASSIFIED_MARKDOWN');
  }
  return issueFromParsed(path, kind, strict, 'error');
}

export async function lintVault(vaultRoot: string, options: VaultLintOptions = {}): Promise<VaultLintReport> {
  const root = resolve(vaultRoot);
  const issues: VaultLintIssue[] = [];
  let files = 0;
  let valid = 0;

  for (const noteRoot of NOTE_ROOTS) {
    const paths = await collectMarkdownFiles(root, noteRoot.directory);
    for (const path of paths) {
      files += 1;
      const issue = await lintFile(root, path, noteRoot.kind, options);
      if (issue === undefined) valid += 1;
      else issues.push(issue);
    }
  }

  issues.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  const errors = issues.length - warnings;
  return {
    root,
    summary: { files, valid, warnings, errors },
    issues
  };
}

function argumentValue(arguments_: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return arguments_.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const root = argumentValue(arguments_, '--vault-root') ?? process.env.VAULT_ROOT;
  if (root === undefined || root.trim() === '') {
    process.stderr.write('VAULT_ROOT_REQUIRED\n');
    process.exitCode = 2;
    return;
  }
  const report = await lintVault(root, { strictUntyped: arguments_.includes('--strict-untyped') });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.summary.errors > 0 ? 2 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}

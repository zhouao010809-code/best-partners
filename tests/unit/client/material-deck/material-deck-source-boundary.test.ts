import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const sourceRoot = resolve(projectRoot, 'src/client/components/material-deck');
const runtimeFiles = [
  'materialDeckLayout.ts',
  'MaterialDeck.tsx',
  'MaterialDeckDetail.tsx',
  'useDeckStyleSheet.ts',
  'material-deck.css'
] as const;
const forbiddenRuntimePatterns = [
  /@ant-design\/icons/u,
  /\bLark\w*/u,
  /\bProduction\w*/u,
  /publish|schedul|archiv/iu,
  /DataRecovery/u,
  /onGoPlanning|onGoContent/u,
  /(?:发布|排期|归档|拍摄|剪辑|审核)/u,
  /\/Users\/ao\/Desktop\/production-deck-source-kit/u
] as const;

function read(relativePath: string): string {
  return readFileSync(resolve(projectRoot, relativePath), 'utf8');
}

function readSource(filename: string): string {
  const path = resolve(sourceRoot, filename);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('MaterialDeck source boundary', () => {
  it('contains the complete domain-free runtime source set', () => {
    for (const filename of runtimeFiles) {
      expect(
        () => readFileSync(resolve(sourceRoot, filename), 'utf8'),
        filename
      ).not.toThrow();
    }
  });

  it('keeps inherited production and external-system coupling out of runtime files', () => {
    const runtimeSource = runtimeFiles
      .map(readSource)
      .join('\n');

    for (const forbidden of forbiddenRuntimePatterns) {
      expect(runtimeSource).not.toMatch(forbidden);
    }
  });

  it.each([
    'publishRecords',
    'openSchedule',
    'archiveTargetRef'
  ])('detects the legacy camelCase or stem probe %s', (probe) => {
    expect(forbiddenRuntimePatterns.some((pattern) => pattern.test(probe))).toBe(true);
  });

  it('contains no React style prop, imperative inline style, or fixed DOM id', () => {
    const runtimeTsx = ['MaterialDeck.tsx', 'MaterialDeckDetail.tsx']
      .map(readSource)
      .join('\n');

    expect(runtimeTsx).not.toMatch(/\bstyle\s*=/u);
    expect(runtimeTsx).not.toMatch(/\.style\.setProperty\s*\(/u);
    expect(runtimeTsx).not.toMatch(/\bid\s*=/u);
  });

  it('does not add the old icon package as a dependency', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies).not.toHaveProperty('@ant-design/icons');
    expect(packageJson.devDependencies).not.toHaveProperty('@ant-design/icons');
  });

  it('records internal provenance without claiming a public license or runtime dependency', () => {
    const sourceNote = readSource('SOURCE.md');

    expect(sourceNote).toContain(
      '/Users/ao/Desktop/production-deck-source-kit-2026-08-31 2/portable/src'
    );
    expect(sourceNote).toContain('2026-09-01');
    expect(sourceNote).toContain('cf4db16fb6bf4498abce8279d310fdc5992ed4d7');
    expect(sourceNote).toContain(
      'b9a32860571a8567feb109fc4f6fb5ada399b27161145b6ce5c250ef9023ee00'
    );
    expect(sourceNote).toMatch(/无公开\s*License|没有公开\s*License/iu);
    expect(sourceNote).toContain('无运行时依赖');
  });
});

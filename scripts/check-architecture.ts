import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ArchitectureViolation = {
  readonly file: string;
  readonly specifier: string;
  readonly rule: string;
};

type Layer = 'shared' | 'client' | 'server' | 'electron';

const sourceExtensions = new Set(['.ts', '.tsx']);
const importPattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;

function filesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function layerFor(path: string, root: string): Layer | undefined {
  const [first] = relative(root, path).split(/[\\/]/u);
  return first === 'shared' || first === 'client' || first === 'server' || first === 'electron' ? first : undefined;
}

function violates(source: Layer, target: Layer): string | undefined {
  if (source === 'shared' && target !== 'shared') return 'shared may depend only on shared modules';
  if (source === 'client' && (target === 'server' || target === 'electron')) return 'client may not depend on server or Electron modules';
  if (source === 'server' && (target === 'client' || target === 'electron')) return 'server may not depend on client or Electron modules';
  if (source === 'electron' && target === 'client') return 'Electron may not depend on client modules';
  return undefined;
}

export function findArchitectureViolations(root: string): ArchitectureViolation[] {
  const sourceRoot = resolve(root, 'src');
  const violations: ArchitectureViolation[] = [];
  for (const file of filesUnder(sourceRoot)) {
    const sourceLayer = layerFor(file, sourceRoot);
    if (sourceLayer === undefined) continue;
    const source = readFileSync(file, 'utf8');
    importPattern.lastIndex = 0;
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (specifier === undefined || !specifier.startsWith('.')) continue;
      const targetLayer = layerFor(resolve(dirname(file), specifier), sourceRoot);
      if (targetLayer === undefined) continue;
      const rule = violates(sourceLayer, targetLayer);
      if (rule !== undefined) violations.push({ file: relative(root, file), specifier, rule });
    }
  }
  return violations;
}

export function formatArchitectureViolations(violations: readonly ArchitectureViolation[]): string {
  return violations.map(item => `- ${item.file} -> ${item.specifier}: ${item.rule}`).join('\n');
}

export function assertArchitecture(root: string): void {
  const violations = findArchitectureViolations(root);
  if (violations.length === 0) return;
  throw new Error(`Architecture boundary violations (${violations.length}):\n${formatArchitectureViolations(violations)}`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
  try {
    assertArchitecture(process.cwd());
    console.log('Architecture boundaries: PASS');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

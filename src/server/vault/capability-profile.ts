import type { VaultCapabilityProfile } from './VaultGateway.js';
import { parse } from 'yaml';

export type OpenApiDeclarations = {
  readonly declaredReplace: boolean;
  readonly declaredCreate: boolean;
  readonly declaredDelete: boolean;
  readonly formalWriteGate: 'blocked';
  readonly evidence: ReadonlyArray<string>;
};

export type ExecutableVaultCapabilityEvidence = Omit<VaultCapabilityProfile, 'formalWriteGate'>;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function resolveParameterReference(root: JsonObject, reference: string): unknown {
  if (!reference.startsWith('#/')) {
    return undefined;
  }
  const rawSegments = reference.slice(2).split('/');
  if (
    rawSegments.length !== 3
    || rawSegments[0] !== 'components'
    || rawSegments[1] !== 'parameters'
  ) {
    return undefined;
  }
  let current: unknown = root;
  for (const rawSegment of rawSegments) {
    const object = asObject(current);
    if (object === undefined) {
      return undefined;
    }
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    current = object[segment];
  }
  return current;
}

function isHeaderParameter(value: unknown, root: JsonObject, headerName: string): boolean {
  let parameter = asObject(value);
  if (parameter === undefined) {
    return false;
  }
  if (typeof parameter.$ref === 'string') {
    parameter = asObject(resolveParameterReference(root, parameter.$ref));
  }
  return parameter?.in === 'header'
    && typeof parameter.name === 'string'
    && parameter.name.toLowerCase() === headerName.toLowerCase();
}

function operationDeclaresHeader(
  root: JsonObject,
  pathItem: JsonObject,
  method: 'patch' | 'put' | 'delete',
  headerName: string
): boolean {
  const operation = asObject(pathItem[method]);
  if (operation === undefined) {
    return false;
  }
  const parameters = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : [])
  ];
  return parameters.some((parameter) => isHeaderParameter(parameter, root, headerName));
}

export function classifyOpenApiDeclarations(document: string): OpenApiDeclarations {
  const root = asObject(parse(document));
  const paths = root === undefined ? undefined : asObject(root.paths);
  const vaultFilePath = paths === undefined ? undefined : asObject(paths['/vault/{filename}']);
  const declaredReplace = root !== undefined
    && vaultFilePath !== undefined
    && operationDeclaresHeader(root, vaultFilePath, 'patch', 'If-Match');
  const declaredCreate = root !== undefined
    && vaultFilePath !== undefined
    && operationDeclaresHeader(root, vaultFilePath, 'put', 'If-Match');
  const declaredDelete = root !== undefined
    && vaultFilePath !== undefined
    && operationDeclaresHeader(root, vaultFilePath, 'delete', 'If-Match');
  const evidence = Object.freeze([
    ...(declaredReplace ? ['PATCH declares If-Match'] : []),
    ...(declaredCreate ? ['PUT declares If-Match'] : []),
    ...(declaredDelete ? ['DELETE declares If-Match'] : [])
  ]);

  return {
    declaredReplace,
    declaredCreate,
    declaredDelete,
    formalWriteGate: 'blocked',
    evidence
  };
}

export function closeWriteGate(
  profile: ExecutableVaultCapabilityEvidence
): VaultCapabilityProfile {
  const passed = profile.safeRead
    && profile.safeReplace
    && profile.safeCreate
    && profile.safeRestore
    && profile.safeDelete
    && profile.restartPersistence === 'passed';
  return { ...profile, formalWriteGate: passed ? 'passed' : 'blocked' };
}

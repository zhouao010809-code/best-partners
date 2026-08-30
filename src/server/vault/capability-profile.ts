import type { VaultCapabilityProfile } from './VaultGateway.js';
import { parse } from 'yaml';

export type OpenApiDeclarations = {
  readonly safeReplace: boolean;
  readonly safeCreate: boolean;
  readonly safeDelete: boolean;
  readonly formalWriteGate: 'blocked';
  readonly evidence: ReadonlyArray<string>;
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function resolveLocalReference(root: JsonObject, reference: string): unknown {
  if (!reference.startsWith('#/')) {
    return undefined;
  }
  let current: unknown = root;
  for (const rawSegment of reference.slice(2).split('/')) {
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
    parameter = asObject(resolveLocalReference(root, parameter.$ref));
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
  const pathItems = paths === undefined
    ? []
    : Object.values(paths).flatMap((value) => {
      const pathItem = asObject(value);
      return pathItem === undefined ? [] : [pathItem];
    });
  const safeReplace = root !== undefined
    && pathItems.some((pathItem) => operationDeclaresHeader(root, pathItem, 'patch', 'If-Match'));
  const safeCreate = root !== undefined
    && pathItems.some((pathItem) => operationDeclaresHeader(root, pathItem, 'put', 'If-Match'));
  const safeDelete = root !== undefined
    && pathItems.some((pathItem) => operationDeclaresHeader(root, pathItem, 'delete', 'If-Match'));
  const evidence = Object.freeze([
    ...(safeReplace ? ['PATCH declares If-Match'] : []),
    ...(safeCreate ? ['PUT declares If-Match'] : []),
    ...(safeDelete ? ['DELETE declares If-Match'] : [])
  ]);

  return {
    safeReplace,
    safeCreate,
    safeDelete,
    formalWriteGate: 'blocked',
    evidence
  };
}

export function closeWriteGate(
  profile: Omit<VaultCapabilityProfile, 'formalWriteGate'>
): VaultCapabilityProfile {
  const passed = profile.safeRead
    && profile.safeReplace
    && profile.safeCreate
    && profile.safeRestore
    && profile.safeDelete
    && profile.restartPersistence === 'passed';
  return { ...profile, formalWriteGate: passed ? 'passed' : 'blocked' };
}

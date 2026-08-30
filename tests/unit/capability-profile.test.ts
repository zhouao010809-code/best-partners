import { describe, expect, it } from 'vitest';
import {
  classifyOpenApiDeclarations,
  closeWriteGate
} from '../../src/server/vault/capability-profile.js';
import type { VaultCapabilityProfile } from '../../src/server/vault/VaultGateway.js';

const openApiWithPatchPrecondition = `
openapi: 3.0.3
info:
  title: Local REST API
  version: 5.1.0
paths:
  /vault/{filename}:
    parameters:
      - name: filename
        in: path
        required: true
        schema:
          type: string
    patch:
      parameters:
        - name: If-Match
          in: header
          required: true
          schema:
            type: string
      responses:
        '200':
          description: replaced
`;

function evidenceProfile(
  overrides: Partial<Omit<VaultCapabilityProfile, 'formalWriteGate'>> = {}
): Omit<VaultCapabilityProfile, 'formalWriteGate'> {
  return {
    pluginId: 'obsidian-local-rest-api',
    pluginVersion: '5.1.0',
    obsidianVersion: '1.8.10',
    safeRead: true,
    safeReplace: true,
    safeCreate: true,
    safeRestore: true,
    safeDelete: true,
    restartPersistence: 'passed',
    evidence: Object.freeze(['executable contract evidence']),
    ...overrides
  };
}

describe('classifyOpenApiDeclarations', () => {
  it('classifies actual method header parameters while keeping the formal gate blocked', () => {
    const declarations = classifyOpenApiDeclarations(openApiWithPatchPrecondition);

    expect(declarations.safeReplace).toBe(true);
    expect(declarations.safeCreate).toBe(false);
    expect(declarations.safeDelete).toBe(false);
    expect(declarations.formalWriteGate).toBe('blocked');
    expect(declarations.evidence).toContain('PATCH declares If-Match');
  });

  it('does not classify raw If-Match mentions in descriptions as header declarations', () => {
    const declarations = classifyOpenApiDeclarations(`
openapi: 3.0.3
info:
  title: Mentions only
  version: 5.1.0
paths:
  /vault/{filename}:
    patch:
      description: Send the If-Match header for safe replace.
      responses:
        '200':
          description: If-Match is discussed here too.
    put:
      description: If-Match would make this safe to create.
    delete:
      description: If-Match would make this safe to delete.
`);

    expect(declarations.safeReplace).toBe(false);
    expect(declarations.safeCreate).toBe(false);
    expect(declarations.safeDelete).toBe(false);
    expect(declarations.formalWriteGate).toBe('blocked');
  });

  it('resolves a referenced If-Match parameter declared at path level', () => {
    const declarations = classifyOpenApiDeclarations(`
openapi: 3.0.3
info:
  title: Referenced parameter
  version: 5.1.0
components:
  parameters:
    ConditionalWrite:
      name: If-Match
      in: header
      schema:
        type: string
paths:
  /vault/{filename}:
    parameters:
      - $ref: '#/components/parameters/ConditionalWrite'
    patch:
      responses:
        '200':
          description: replaced
`);

    expect(declarations.safeReplace).toBe(true);
    expect(declarations.safeCreate).toBe(false);
    expect(declarations.safeDelete).toBe(false);
    expect(declarations.formalWriteGate).toBe('blocked');
  });

  it.each([
    '#/components/schemas/NotAParameter',
    '#/components/parameters/MissingParameter',
    'https://example.invalid/parameters/ConditionalWrite'
  ])('fails closed for unsupported, missing, or nonlocal parameter ref %s', (reference) => {
    const declarations = classifyOpenApiDeclarations(`
openapi: 3.0.3
info:
  title: Unsupported parameter reference
  version: 5.1.0
components:
  schemas:
    NotAParameter:
      name: If-Match
      in: header
      type: string
paths:
  /vault/{filename}:
    patch:
      parameters:
        - $ref: '${reference}'
      responses:
        '200':
          description: replaced
`);

    expect(declarations.safeReplace).toBe(false);
    expect(declarations.safeCreate).toBe(false);
    expect(declarations.safeDelete).toBe(false);
    expect(declarations.formalWriteGate).toBe('blocked');
  });
});

describe('closeWriteGate', () => {
  it('passes only a complete executable evidence profile', () => {
    expect(closeWriteGate(evidenceProfile()).formalWriteGate).toBe('passed');
  });

  it.each([
    ['safeRead', { safeRead: false }],
    ['safeReplace', { safeReplace: false }],
    ['safeCreate', { safeCreate: false }],
    ['safeRestore', { safeRestore: false }],
    ['safeDelete', { safeDelete: false }],
    ['restartPersistence unverified', { restartPersistence: 'unverified' as const }],
    ['restartPersistence failed', { restartPersistence: 'failed' as const }]
  ])('blocks when %s is missing, failed, or unverified', (_name, overrides) => {
    expect(closeWriteGate(evidenceProfile(overrides)).formalWriteGate).toBe('blocked');
  });
});

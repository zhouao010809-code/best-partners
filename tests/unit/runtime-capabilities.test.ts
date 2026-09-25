import { describe, expect, it } from 'vitest';
import type { AttachmentService } from '../../src/server/attachments/service.js';
import { applyRuntimeCapabilities, type RuntimeCapabilities } from '../../src/server/runtime/capabilities.js';

function health() {
  return { getSnapshot: async () => ({}) } as RuntimeCapabilities['health'];
}

describe('runtime capabilities', () => {
  it('keeps legacy options untouched when no capability object is supplied', () => {
    const options = { healthService: health() };
    expect(applyRuntimeCapabilities(options)).toBe(options);
  });

  it('maps explicit capabilities at the compatibility boundary', () => {
    const capabilityHealth = health();
    const attachmentService = { ready: async () => undefined, close: async () => undefined } as AttachmentService;
    const options = {
      healthService: health(),
      capabilities: {
        health: capabilityHealth,
        personal: { attachmentService }
      }
    } satisfies { capabilities: RuntimeCapabilities; healthService: RuntimeCapabilities['health'] };

    const resolved = applyRuntimeCapabilities(options);

    expect(resolved).not.toBe(options);
    expect(resolved.capabilities).toBeUndefined();
    expect(resolved.healthService).toBe(capabilityHealth);
    expect(resolved.attachmentService).toBe(attachmentService);
  });
});

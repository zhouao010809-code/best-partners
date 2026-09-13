import { expect, it } from 'vitest';
import { createIntakeMutationGate } from '../../src/server/services/intake-mutation-gate.js';
it('prevents archive and recycle writes from overlapping across awaits', async () => {
  const run = createIntakeMutationGate(); let finish!: () => void; let touched = false;
  const first = run(() => new Promise<void>(resolve => { finish = resolve; }));
  await expect(run(async () => { touched = true; })).rejects.toMatchObject({ code: 'INTAKE_TRASH_BUSY' });
  expect(touched).toBe(false); finish(); await first;
  await run(async () => { touched = true; }); expect(touched).toBe(true);
});
it('releases the gate even when a write fails', async () => {
  const run = createIntakeMutationGate();
  await expect(run(async () => { throw new Error('test failure'); })).rejects.toThrow('test failure');
  await expect(run(async () => 42)).resolves.toBe(42);
});

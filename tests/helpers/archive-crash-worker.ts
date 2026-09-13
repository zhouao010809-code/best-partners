import { writeSync } from 'node:fs';
import { prepareArchiveMove, executeArchiveMove } from '../../src/server/archive/archive-coordinator.js';
import { openSandboxArchive } from '../../src/server/archive/sandbox-native.js';
import { archiveOperationId as id, archiveSource as source, archiveTarget as target } from './archive-fixture.js';

const [root, addon, checkpoint] = process.argv.slice(2);
if (!root || !addon || !['after-intent', 'after-move', 'before-result', 'lock-only'].includes(checkpoint!)) throw new Error('INVALID_TEST_ARGUMENT');
const port = { ...openSandboxArchive(root, addon) };
function crash(): never {
  writeSync(1, `checkpoint:${checkpoint}\n`);
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL_RETURNED');
}
if (checkpoint === 'lock-only') { writeSync(1, 'opened\n'); port.close(); }
else {
  prepareArchiveMove(port, { id, source, target });
  if (checkpoint === 'after-intent') crash();
  const move = port.move.bind(port);
  port.move = (...args) => { move(...args); if (checkpoint === 'after-move') crash(); };
  const write = port.writeRecovery.bind(port);
  port.writeRecovery = (name, bytes) => { if (checkpoint === 'before-result' && name.endsWith('.result.json')) crash(); write(name, bytes); };
  executeArchiveMove(port, id);
  throw new Error('CHECKPOINT_NOT_REACHED');
}

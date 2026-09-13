import { app } from 'electron';
import { openSandboxArchive } from '../../src/server/archive/sandbox-native.js';
import { prepareArchiveMove, executeArchiveMove } from '../../src/server/archive/archive-coordinator.js';
import { archiveSource as source, archiveTarget as target } from './archive-fixture.js';

void app.whenReady().then(() => {
  const [root, addon] = process.argv.slice(2);
  if (!root || !addon) throw new Error('INVALID_TEST_ARGUMENT');
  const port = openSandboxArchive(root, addon);
  let status = 1;
  try {
    const intent = prepareArchiveMove(port, { source, target });
    const result = executeArchiveMove(port, intent.id);
    process.stdout.write(`ARCHIVE_ELECTRON_RESULT:${JSON.stringify(result)}\n`);
    status = result.state === 'moved' ? 0 : 1;
  } finally { port.close(); }
  app.exit(status);
}).catch((error: unknown) => { process.stderr.write(String(error)); app.exit(1); });

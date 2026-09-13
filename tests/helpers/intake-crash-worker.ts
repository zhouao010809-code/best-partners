import { openPersonalArchive, type PersonalArchivePort } from '../../src/server/archive/sandbox-native.js';
import { captureArchiveTree } from '../../src/server/archive/archive-snapshot.js';
import { prepareIntakeArchive, executeIntakeArchive } from '../../src/server/archive/intake-archive.js';
import { planIntakeMain } from '../../src/server/archive/intake-plan.js';
import { archiveSource as source } from './archive-fixture.js';
const [root, recovery, addon, checkpoint] = process.argv.slice(2);
if (!root || !recovery || !addon || !checkpoint) throw new Error('INVALID_FIXTURE');
const port = openPersonalArchive(root, recovery, addon);
const plan = planIntakeMain({ packageName: '资料包', mainName: '原文.md', bytes: port.read(`${source}/原文.md`),
  fields: { platform: '个人', title: '资料包', collectedAt: '2026-09-05' } });
const intent = prepareIntakeArchive(port, { source, tree: captureArchiveTree(port, source), plan, ruleFingerprint: 'a'.repeat(64) });
function crash() { process.stdout.write(`INTAKE_ID:${intent.id}\n`); process.kill(process.pid, 'SIGKILL'); }
if (checkpoint === 'intent') crash();
const wrapped = { ...port };
for (const method of ['swapMain', 'renameMain', 'move'] as const) {
  Object.assign(wrapped, { [method]: (...args: unknown[]) => {
    (port[method] as (...args: unknown[]) => void)(...args); if (checkpoint === method) crash();
  } });
}
executeIntakeArchive(wrapped as PersonalArchivePort, intent.id, 'a'.repeat(64));
port.close();

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execute = promisify(execFile);

// Check the running bundle, not the user's keychain: recipients do not have
// the publisher's signing key. Squirrel enforces its designated requirement
// against the replacement app before allowing installation.
export async function supportsAutomaticUpdates(input: {
  packaged: boolean; platform: string; arch: string; executable: string;
  verify?: (bundle: string) => Promise<void>;
}): Promise<boolean> {
  if (!input.packaged || input.platform !== 'darwin' || input.arch !== 'arm64') return false;
  const bundle = resolve(input.executable, '../../..');
  if (!bundle.endsWith('.app')) return false;
  try {
    if (input.verify) await input.verify(bundle);
    else await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R',
      'anchor apple generic and identifier "local.xiaozhao.brain" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', bundle], { timeout: 15_000 });
    return true;
  } catch { return false; }
}

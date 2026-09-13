import { PublicApiError } from '../../shared/api/errors.js';

/** Shared by archive and packet recycling, including async rule/index checks. */
export function createIntakeMutationGate() {
  let busy = false;
  return async function run<T>(action: () => Promise<T>): Promise<T> {
    if (busy) throw new PublicApiError('INTAKE_TRASH_BUSY', '收件箱正在处理上一项操作，请稍等。', 409);
    busy = true;
    try { return await action(); } finally { busy = false; }
  };
}

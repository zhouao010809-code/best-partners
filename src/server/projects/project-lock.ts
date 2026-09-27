import type Database from 'better-sqlite3';

// The registry/index service and output writer share one runtime connection.
// Serializing their complete operations prevents a stale scan from replacing
// an index after a confirmed file has already been written and indexed.
const projectQueues = new WeakMap<Database.Database, Map<string, Promise<unknown>>>();

export function withProjectLock<T>(database: Database.Database, projectId: string, operation: () => Promise<T>): Promise<T> {
  let queues = projectQueues.get(database);
  if (!queues) { queues = new Map(); projectQueues.set(database, queues); }
  const previous = queues.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(projectId, next);
  const release = () => { if (queues.get(projectId) === next) queues.delete(projectId); };
  void next.then(release, release);
  return next;
}

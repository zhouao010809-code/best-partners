export interface CompanySignalTarget {
  exitCode?: string | number | null | undefined;
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface CompanyShutdownController {
  shutdown(): Promise<void>;
  dispose(): void;
}

export function installCompanySignalHandlers(
  close: () => void | Promise<void>,
  target: CompanySignalTarget = process
): CompanyShutdownController {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= Promise.resolve().then(close);
    return shutdownPromise;
  };
  const handle = () => {
    void shutdown().catch(() => { target.exitCode = 1; });
  };
  target.on('SIGINT', handle);
  target.on('SIGTERM', handle);
  return {
    shutdown,
    dispose: () => {
      target.off('SIGINT', handle);
      target.off('SIGTERM', handle);
    }
  };
}

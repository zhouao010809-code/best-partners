import { useOutletContext } from 'react-router-dom';
import type {
  ClientFailureState,
  HealthSnapshot,
  ReadConsoleApi
} from '../api/client.js';

export type Resource<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'refreshing'; readonly data?: T }
  | {
    readonly status: 'failed';
    readonly state: ClientFailureState;
    readonly data?: T;
  };

export interface ConsoleRuntime {
  readonly api: ReadConsoleApi;
  readonly health: Resource<HealthSnapshot>;
  readonly dataRevision: number;
  readonly refreshHealth: () => Promise<void>;
}

export function useConsoleRuntime(): ConsoleRuntime {
  return useOutletContext<ConsoleRuntime>();
}

import type {
  ApiClientResult,
  ClientFailureState,
  HealthSnapshot
} from '../api/client.js';
import type { Resource } from '../app/ConsoleRuntime.js';

export type PageResource<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'refreshing'; readonly data?: T; readonly message?: string }
  | { readonly status: 'failed'; readonly state: ClientFailureState; readonly data?: T };

export function isCancelled<T>(
  result: ApiClientResult<T>
): result is { readonly ok: false; readonly cancelled: true } {
  return !result.ok && 'cancelled' in result;
}

export function stableFailure(
  status: ClientFailureState['status'],
  context: '读取页面' | '读取材料' | '读取知识' | '读取操作' | '打开知识' = '读取页面'
): ClientFailureState {
  switch (status) {
    case 'disconnected':
      return { status, message: '无法连接本地服务。' };
    case 'validation-error':
      return { status, message: `${context}响应不符合只读契约。` };
    case 'operation-error':
      return { status, message: `${context}未完成，请稍后重试。` };
    case 'busy':
      return { status, message: '索引正在更新，请稍后再试。' };
    case 'conflict':
      return { status, message: '知识版本与列表不一致，请刷新后重试' };
    case 'recovery-required':
      return { status, message: '系统处于恢复模式，当前只读数据不可用。' };
  }
}

export function validationState(message: string): ClientFailureState {
  return { status: 'validation-error', message };
}

export function dataFromResource<T>(resource: Resource<T>): T | undefined {
  return 'data' in resource ? resource.data : undefined;
}

export function indexCanServe(snapshot: HealthSnapshot | undefined): snapshot is HealthSnapshot & {
  readonly index: Extract<HealthSnapshot['index'], { readonly status: 'ready' | 'stale' }>;
} {
  return snapshot?.index.status === 'ready' || snapshot?.index.status === 'stale';
}

export function trimOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

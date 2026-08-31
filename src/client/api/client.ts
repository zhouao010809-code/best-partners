import type { z } from 'zod';
import { apiFailureSchema } from '../../shared/api/schemas.js';
import type { PageStateValue } from '../components/PageState.js';

type ClientFailureStatus =
  | 'disconnected'
  | 'validation-error'
  | 'operation-error'
  | 'busy'
  | 'conflict'
  | 'recovery-required';

type ClientFailureState = Extract<PageStateValue, { readonly status: ClientFailureStatus }>;

export type ApiClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false;
    readonly state: ClientFailureState;
    readonly operationId?: string;
  };

export interface ApiRequestOptions<T> {
  readonly path: string;
  readonly schema: z.ZodType<T>;
  readonly init?: RequestInit;
}

function validationFailure(message: string): ApiClientResult<never> {
  return {
    ok: false,
    state: { status: 'validation-error', message }
  };
}

function failureStatus(code: string): ClientFailureStatus {
  switch (code) {
    case 'RECOVERY_REQUIRED':
    case 'READ_API_UNAVAILABLE':
      return 'recovery-required';
    case 'VALIDATION_ERROR':
      return 'validation-error';
    case 'INDEX_BUSY':
      return 'busy';
    case 'VERSION_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
      return 'conflict';
    default:
      return 'operation-error';
  }
}

export async function requestApi<T>(
  options: ApiRequestOptions<T>
): Promise<ApiClientResult<T>> {
  let response: Response;
  try {
    response = await fetch(options.path, {
      ...options.init,
      credentials: 'same-origin'
    });
  } catch {
    return {
      ok: false,
      state: {
        status: 'disconnected',
        message: '无法连接本地服务。'
      }
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return validationFailure('服务返回了无法解析的响应。');
  }

  if (!response.ok) {
    const failure = apiFailureSchema.safeParse(payload);
    if (!failure.success) {
      return validationFailure('服务错误结构无法校验。');
    }

    const { code, message, operationId } = failure.data.error;
    return {
      ok: false,
      state: { status: failureStatus(code), message },
      operationId
    };
  }

  const parsed = options.schema.safeParse(payload);
  if (!parsed.success) {
    return validationFailure('响应结构与当前客户端不兼容。');
  }

  return { ok: true, value: parsed.data };
}

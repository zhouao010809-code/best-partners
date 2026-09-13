export interface ModelCredentialsStatus {
  readonly available: boolean;
  readonly configured: boolean;
  readonly revision: string;
  readonly problem?: string;
}

export interface ModelCredentialsPort {
  readonly status: () => ModelCredentialsStatus;
  readonly getKey: () => string;
  readonly setKey: (apiKey: string) => void;
  readonly clear: () => void;
}

const credentialMessages = {
  UNAVAILABLE: '系统加密不可用，无法保存或读取 API Key。',
  NOT_CONFIGURED: '尚未配置 DeepSeek API Key。',
  INVALID_KEY: 'API Key 格式不正确。',
  STORAGE_FAILED: '无法安全保存或读取 API Key，请重新配置。'
} as const;

export class ModelCredentialsError extends Error {
  constructor(readonly code: keyof typeof credentialMessages) {
    super(credentialMessages[code]);
    this.name = 'ModelCredentialsError';
  }
}

export function normalizeModelApiKey(value: string): string {
  if (typeof value !== 'string') throw new ModelCredentialsError('INVALID_KEY');
  const key = value.trim();
  if (!key || key.length > 512 || !/^[\x20-\x7e]+$/.test(key)) {
    throw new ModelCredentialsError('INVALID_KEY');
  }
  return key;
}

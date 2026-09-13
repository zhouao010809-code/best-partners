const MAX_TITLE_LENGTH = 300;
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_PACKET_ID_LENGTH = 128;

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(reason) {
  return { ok: false, error: reason };
}

function isSafeUrl(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return false;
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]{1,2}|~[\\/])/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isIsoDate(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && /^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2}))$/u.test(value);
}

function validateClipperPayload(input) {
  if (!isPlainObject(input)) return invalid('payload must be an object');
  const required = ['packetId', 'title', 'url', 'content', 'clippedAt'];
  const keys = Object.keys(input);
  if (keys.some((key) => !required.includes(key)) || required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))) {
    return invalid('payload fields are incomplete or unknown');
  }
  if (typeof input.packetId !== 'string' || input.packetId.length === 0 || input.packetId.length > MAX_PACKET_ID_LENGTH || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(input.packetId)) {
    return invalid('packetId is invalid');
  }
  if (typeof input.title !== 'string' || input.title.trim().length === 0 || [...input.title].length > MAX_TITLE_LENGTH) {
    return invalid('title is required and must be at most 300 characters');
  }
  if (!isSafeUrl(input.url)) return invalid('url must be an http(s) URL');
  if (typeof input.content !== 'string' || byteLength(input.content) > MAX_CONTENT_BYTES) {
    return invalid('content must be a string no larger than 10 MiB');
  }
  if (!isIsoDate(input.clippedAt)) return invalid('clippedAt must be an ISO timestamp');
  return { ok: true, value: input };
}

function makePacketId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function createClipperPayload(input) {
  const title = String(input?.title ?? '').trim();
  const content = String(input?.content ?? '').trim();
  const clippedAt = input?.clippedAt ?? new Date().toISOString();
  const payload = {
    packetId: input?.packetId ?? makePacketId(),
    title,
    url: String(input?.url ?? '').trim(),
    content,
    clippedAt
  };
  const result = validateClipperPayload(payload);
  if (!result.ok) throw new TypeError(result.error);
  return result.value;
}

const clipperPayloadSchema = {
  safeParse(input) {
    const result = validateClipperPayload(input);
    return result.ok ? { success: true, data: result.value } : { success: false, error: result.error };
  },
  parse(input) {
    const result = validateClipperPayload(input);
    if (!result.ok) throw new TypeError(result.error);
    return result.value;
  }
};

const parseClipperPayload = clipperPayloadSchema.parse.bind(clipperPayloadSchema);

export { MAX_TITLE_LENGTH, MAX_CONTENT_BYTES, clipperPayloadSchema, createClipperPayload, parseClipperPayload, validateClipperPayload };

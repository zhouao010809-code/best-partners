const RELEASE_PATH = '/zhouao010809-code/best-partners/releases';
const MAX_UPDATE_URL_LENGTH = 2048;

function isReleasePath(pathname: string): boolean {
  return pathname === RELEASE_PATH
    || new RegExp(`^${RELEASE_PATH}/tag/[^/]+$`, 'u').test(pathname)
    || new RegExp(`^${RELEASE_PATH}/download/[^/]+/[^/]+$`, 'u').test(pathname);
}

export function validateUpdateUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_UPDATE_URL_LENGTH || value.trim() !== value) {
    throw new Error('UPDATE_URL_INVALID');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('UPDATE_URL_INVALID');
  }
  const authority = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/]+)/iu)?.[1];
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || authority !== 'github.com'
    || url.username || url.password || url.port || url.search || url.hash || !isReleasePath(url.pathname)) {
    throw new Error('UPDATE_URL_INVALID');
  }
  return value;
}

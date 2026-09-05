export function createDesktopWindowPolicy(origin: string) {
  const expected = new URL(origin);
  if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1' || !expected.port) {
    throw new Error('DESKTOP_ORIGIN_INVALID');
  }
  return {
    allowNavigation(value: string): boolean {
      try {
        const url = new URL(value);
        return url.origin === expected.origin && !url.username && !url.password;
      } catch { return false; }
    },
    allowExternal(value: string): boolean {
      try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'obsidian:') && !url.username && !url.password;
      } catch { return false; }
    }
  };
}

import { BrowserRouter } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { AppRouter } from './app/router.js';

export default function App() {
  // Keep the personal shell as the synchronous fallback for existing desktop
  // consumers. A company server advertises its mode through the public
  // bootstrap endpoint, after which the route tree is swapped wholesale; the
  // company shell never receives the personal API client.
  const [runtimeMode, setRuntimeMode] = useState<'pending' | 'personal' | 'company'>(
    typeof globalThis.fetch === 'function' ? 'pending' : 'personal'
  );
  useEffect(() => {
    if (typeof globalThis.fetch !== 'function') return undefined;
    let disposed = false;
    void globalThis.fetch('/api/v1/bootstrap', { credentials: 'same-origin' })
      .then(async response => {
        if (!response.ok) return undefined;
        const payload: unknown = await response.json();
        if (typeof payload !== 'object' || payload === null || !('data' in payload)) return undefined;
        const data = payload.data;
        if (typeof data !== 'object' || data === null || !('runtimeMode' in data)) return undefined;
        return data.runtimeMode === 'company' ? 'company' : 'personal';
      })
      .then(mode => { if (!disposed) setRuntimeMode(mode ?? 'personal'); })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, []);
  return (
    <BrowserRouter>
      <AppRouter runtimeMode={runtimeMode} />
    </BrowserRouter>
  );
}

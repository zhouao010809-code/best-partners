import { useEffect, useState } from 'react';

/** Retains an unsent request across the settings round-trip on the current local connection. */
export function useCreationInput(key: string) {
  const state = useState(() => {
    try { return (localStorage.getItem(key) ?? '').slice(0, 4000); } catch { return ''; }
  });
  const [text] = state;
  useEffect(() => {
    try { if (text) localStorage.setItem(key, text); else localStorage.removeItem(key); } catch { /* Editing remains available. */ }
  }, [key, text]);
  return state;
}

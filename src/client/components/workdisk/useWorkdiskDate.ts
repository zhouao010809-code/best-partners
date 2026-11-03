import { useEffect, useState } from 'react';

export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function useWorkdiskDate() {
  const [today, setToday] = useState(localDay);
  const [chosenDate, setChosenDate] = useState<string>();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const sync = () => {
      clearTimeout(timer);
      const now = new Date();
      setToday(localDay(now));
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(sync, Math.max(100, midnight.getTime() - now.getTime() + 100));
    };
    sync();
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => { clearTimeout(timer); window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); };
  }, []);
  return {
    today,
    saveDate: chosenDate ?? today,
    followsToday: chosenDate === undefined,
    chooseDate(value: string) { if (value) setChosenDate(value); },
    followToday() { setChosenDate(undefined); setToday(localDay()); },
    // Read the clock again at submission: a background window's timer may be delayed.
    dateForSubmission() { return chosenDate ?? localDay(); }
  };
}

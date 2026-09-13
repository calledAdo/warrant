import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

export function usePoll<T>(path: string | null, interval = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => { setData(null); setError(null); }, [path]);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    async function tick() {
      if (controller.signal.aborted || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      try {
        const result = await api<T>(path!, { signal: controller.signal });
        if (!controller.signal.aborted) { setData(result); setError(null); }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof ApiError ? e : new ApiError('Unable to load this information.'));
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          if (interval) timer = setTimeout(() => { if (!document.hidden) void tick(); }, interval);
        }
      }
    }
    const wake = () => { if (!document.hidden) void tick(); };
    setLoading(true);
    void tick();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); };
  }, [path, interval, revision]);
  return { data, error, loading, refresh };
}

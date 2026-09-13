import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Run } from '@/lib/types';

export function useRun(id: string | null) {
  const [run, setRun] = useState<Run | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting' | 'unavailable'>('connecting');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRun(null); setError(null); setConnection('connecting');
    if (!id) return;
    const controller = new AbortController();
    const events = new EventSource(`/api/events/${encodeURIComponent(id)}`);
    let fallbackTimer: ReturnType<typeof setTimeout>;
    const readSnapshot = async () => {
      try {
        const data = await api<Run>(`/api/runs/${encodeURIComponent(id)}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setRun(data); setError(null); }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 404) {
          events.close(); setConnection('unavailable');
          setError('This investigation is no longer available. Its saved report remains in the queue, but the server may have restarted.');
          return;
        }
        setError('Connection interrupted. Reconnecting to the investigation…');
      }
      if (!controller.signal.aborted && events.readyState !== EventSource.OPEN) fallbackTimer = setTimeout(readSnapshot, 5000);
    };
    events.onopen = () => { setConnection('live'); setError(null); clearTimeout(fallbackTimer); };
    events.onmessage = event => {
      try { const data = JSON.parse(event.data) as Run; if (data.id === id) { setRun(data); setConnection('live'); setError(null); } }
      catch { setError('An update could not be read. Reconnecting…'); }
    };
    events.onerror = () => {
      setConnection('reconnecting'); clearTimeout(fallbackTimer); fallbackTimer = setTimeout(readSnapshot, 500);
    };
    return () => { controller.abort(); events.close(); clearTimeout(fallbackTimer); };
  }, [id]);
  return { run, connection, error };
}

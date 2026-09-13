export class ApiError extends Error {
  constructor(message: string, public status = 0) { super(message); this.name = 'ApiError'; }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const timeout = AbortSignal.timeout(20000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(path, { ...options, signal, headers: { 'Content-Type': 'application/json', ...options.headers } });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(timeout.aborted ? 'This is taking longer than expected. Please try again.' : 'Could not connect. Check your connection and try again.');
  }
  let data;
  try { data = await response.json(); }
  catch { throw new ApiError('The server returned an unexpected response. Please try again.', response.status); }
  if (!response.ok || data?.error) throw new ApiError(data?.error || 'Something went wrong. Please try again.', response.status);
  return data as T;
}

export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

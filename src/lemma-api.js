export const lemmaConfigured = () => Boolean(process.env.LEMMA_API_KEY && process.env.LEMMA_PROJECT_ID);
export async function lemmaGet(path, params = {}) {
  const url = new URL(path, 'https://api.uselemma.ai');
  for (const [key,value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.LEMMA_API_KEY}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Lemma ${response.status}`);
  return response.json();
}

/**
 * OpenAI-compatible chat completion over plain fetch — no SDK, so it works
 * with any gateway that speaks /chat/completions regardless of SDK version.
 */
const BASE = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = () => process.env.OPENAI_MODEL || 'gpt-4o';

export async function completeJSON({ system, user, maxTokens = 1200 }) {
  const started = Date.now();
  const body = {
    model: MODEL(),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  };

  let res = await fetch(`${BASE()}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // Some gateways reject response_format. Retry once without it.
  if (!res.ok && res.status === 400) {
    delete body.response_format;
    body.messages[0].content += '\n\nRespond with a single JSON object and nothing else.';
    res = await fetch(`${BASE()}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? '';
  const usage = json.usage || {};

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Tolerate ```json fences or surrounding prose.
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`LLM returned non-JSON: ${content.slice(0, 200)}`);
    parsed = JSON.parse(m[0]);
  }

  return {
    parsed,
    raw: content,
    model: json.model || MODEL(),
    durationMs: Date.now() - started,
    usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
    },
  };
}

export async function ping() {
  const r = await completeJSON({
    system: 'You reply only with JSON.',
    user: 'Reply with {"ok":true}',
    maxTokens: 20,
  });
  return r.parsed;
}

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

/**
 * One model turn with tools. Returns the assistant message (which may carry
 * tool_calls) plus usage. No response_format here: providers reject it
 * alongside tools, and the final answer is parsed by the caller.
 */
export async function chatWithTools({ messages, tools, toolChoice = 'auto', maxTokens = 1400 }) {
  const started = Date.now();
  const body = JSON.stringify({ model: MODEL(), messages, tools, tool_choice: toolChoice, temperature: 0, max_tokens: maxTokens });
  let res;
  // Free tiers rate-limit per minute. Wait as long as the provider asks (capped)
  // and retry before treating the model as unavailable.
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(`${BASE()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body,
    });
    if (res.status !== 429) break;
    const text = await res.text().catch(() => '');
    const hinted = Number(res.headers.get('retry-after')) * 1000 || (Number((text.match(/try again in ([\d.]+)(ms|s)/) || [])[1]) * ((text.match(/try again in [\d.]+(ms|s)/) || [])[1] === 's' ? 1000 : 1)) || 0;
    const wait = Math.min(15000, Math.max(hinted + 250, 1000 * 2 ** attempt));
    console.warn(`  [llm] rate limited, retrying in ${Math.round(wait)}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
    try { err.body = JSON.parse(text); } catch {}
    throw err;
  }
  const json = await res.json();
  const message = json.choices?.[0]?.message ?? { role: 'assistant', content: '' };
  return {
    message: { role: 'assistant', content: message.content ?? '', ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) },
    model: json.model || MODEL(),
    durationMs: Date.now() - started,
    usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
  };
}

/** Pull a JSON object out of model text (tolerates fences and prose). */
export function parseJSONObject(text) {
  try { return JSON.parse(text); } catch {}
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`model returned non-JSON: ${String(text).slice(0, 200)}`);
  return JSON.parse(m[0]);
}

/**
 * Warrant LLM client — routes all model calls through Nightshift's OpenAI-compatible API,
 * pinning NVIDIA Nemotron models by name. Records every compute receipt (receipt ID,
 * routed model, provider) in Warrant's trace.
 * Two lanes:
 *   fast = nvidia/nemotron-3.5-lightning-30b-a3b (extraction, hypotheses)
 *   deep = nvidia/nemotron-3-ultra-550b-a55b (judgement, critique)
 * Reasoning toggle via chat_template_kwargs.enable_thinking.
 * Invalid structured replies get one repair retry; transient transport failures get one retry.
 */
import { randomUUID } from 'node:crypto';
// Trace is imported dynamically where needed; we only use the emit method

/** @typedef {'fast' | 'deep'} Lane */

/** @typedef {Object} Receipt
 * @property {string|null} receiptId
 * @property {string} requestedModel
 * @property {string|null} routedModel
 * @property {string|null} provider
 * @property {number|null} latencyMs
 * @property {number|null} inputTokens
 * @property {number|null} outputTokens
 * @property {number|null} costUsd
 * @property {string|null} privacyPath
 * @property {boolean} replayed
 * @property {boolean} [cached]
 */

export class LlmUnavailable extends Error {}

const DEFAULT_MODELS = {
  fast: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  deep: 'nvidia/nemotron-3-ultra-550b-a55b',
};

const FAST_MODEL = process.env.NIGHTSHIFT_FAST_MODE || DEFAULT_MODELS.fast;
const DEEP_MODEL = process.env.NIGHTSHIFT_DEEP_MODE || DEFAULT_MODELS.deep;

/** @param {Lane} lane */
function modelFor(lane) {
  return lane === 'fast' ? FAST_MODEL : DEEP_MODEL;
}

/** @param {Object} req */
async function post(req) {
  const base = (process.env.METERLESS_BASE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('METERLESS_BASE_URL not set');
  const token = process.env.METERLESS_RUNTIME_TOKEN;
  if (!token) throw new Error('METERLESS_RUNTIME_TOKEN not set');
  const appId = process.env.WARRANT_METERLESS_APP_ID || 'warrant';

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'meterless-app': appId,
      'meterless-scope': 'user',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 180000)),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** @param {Object} body */
/** @param {string} requestedModel */
/** @param {boolean} replayed */
function receiptOf(body, requestedModel, replayed) {
  const m = body?.meterless ?? {};
  return {
    receiptId: m.receipt_id ?? m.receipt?.receipt_id ?? null,
    requestedModel,
    routedModel: m.routed_model ?? m.winning_route?.model ?? body?.model ?? null,
    provider: m.winning_route?.provider ?? m.egress?.destination ?? null,
    latencyMs: m.usage?.latency_ms ?? null,
    inputTokens: m.usage?.input_tokens ?? null,
    outputTokens: m.usage?.output_tokens ?? null,
    costUsd: m.cost?.actual_usd ?? null,
    privacyPath: m.privacy?.path ?? null,
    replayed,
  };
}

/** Pulls the last complete JSON object (or array) out of a reply that may include reasoning. */
/** @param {string} text */
export function extractJson(text) {
  const cleaned = text.replace(/^\s*<\/?think>\s*/g, '').replace(/^\s*question[\s\S]*?<\/think>\s*/, '');
  const candidates = [];
  for (let i = 0; i < cleaned.length; i++) {
    const open = cleaned[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < cleaned.length; j++) {
      const ch = cleaned[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) { candidates.push(cleaned.slice(i, j + 1)); i = j; break; }
    }
  }
  for (let k = candidates.length - 1; k >= 0; k--) {
    try { return JSON.parse(candidates[k]); } catch { /* try the previous block */ }
  }
  throw new Error('no JSON object found in model reply');
}

/**
 * @template T
 * @param {{
 *   lane: Lane;
 *   agent: string;
 *   purpose: string;
 *   system: string;
 *   user: string;
 *   validate: (value: unknown) => T;
 *   reasoning?: boolean;
 *   maxTokens?: number;
 *   temperature?: number;
 *   trace: Trace;
 *   runDir?: string;
 * }} o
 */
export async function chatJson(o) {
  const model = modelFor(o.lane);
  // Check if using meterless modes that may route to local models
  const isMeterlessMode = model.startsWith('meterless/');
  const messages = isMeterlessMode
    ? [{ role: 'user', content: `${o.system}\n\n${o.user}` }]
    : [{ role: 'system', content: o.system }, { role: 'user', content: o.user }];
  let lastError = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const reasoning = o.reasoning ?? true;
    const req = {
      model,
      temperature: o.temperature ?? 0.2,
      max_tokens: o.maxTokens ?? (reasoning ? 8000 : 2000),
      messages: [...messages],
    };
    if (!reasoning) req.chat_template_kwargs = { enable_thinking: false };

    let res;
    const started = Date.now();
    try {
      res = await post(req);
    } catch (err) {
      res = { status: 599, body: { error: { message: 'Provider connection failed or timed out' } } };
    }

    if (o.runDir) {
      // Record LLM request/response for cassette replay
      const { record } = await import('./cassette.js');
      record(o.runDir, 'llm', req, res);
    }

    const receipt = receiptOf(res.body, model, false);
    o.trace.emit('llm', o.agent, `${o.purpose} -> ${receipt.routedModel ?? model} (live, HTTP ${res.status}) ${receipt.latencyMs ?? '?'}ms`, {
      lane: o.lane, purpose: o.purpose, reasoning, attempt, status: res.status, elapsedMs: Date.now() - started, receipt,
    });

    if (res.status !== 200) {
      if (res.status >= 500 || res.status === 429) {
        o.trace.emit('fallback', o.agent, `Nightshift returned ${res.status} on ${model}; retrying once`, { status: res.status });
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw new LlmUnavailable(`Nightshift ${res.status} for ${model}`);
    }

    const content = String(res.body?.choices?.[0]?.message?.content ?? '');
    try {
      const value = o.validate(extractJson(content));
      return { value, receipt };
    } catch (err) {
      lastError = err.message;
      o.trace.emit('revision', o.agent, `${o.purpose}: reply rejected (${lastError}); asking the model to repair it`, { lane: o.lane, attempt, receipt });
      messages.push({ role: 'assistant', content: content.slice(-6000) }, { role: 'user', content: `That reply was rejected: ${lastError}. Reply again with ONLY the JSON object in the required shape.` });
    }
  }
  throw new LlmUnavailable(`${o.agent}/${o.purpose}: no valid reply after repair (${lastError})`);
}

/** Legacy compatibility: simple JSON completion without tools. */
export async function completeJSON({ system, user, maxTokens = 1200 }) {
  const { value, receipt } = await chatJson({
    lane: 'fast',
    agent: 'legacy',
    purpose: 'completeJSON',
    system,
    user,
    validate: (v) => v,
    reasoning: false,
    maxTokens,
    trace: { emit: () => {} },
  });
  return {
    parsed: value,
    raw: JSON.stringify(value),
    model: receipt.routedModel,
    durationMs: receipt.latencyMs ?? 0,
    usage: { inputTokens: receipt.inputTokens ?? 0, outputTokens: receipt.outputTokens ?? 0 },
    receipt,
  };
}

/** Legacy compatibility: ping. */
export async function ping() {
  const r = await completeJSON({ system: 'You reply only with JSON.', user: 'Reply with {"ok":true}', maxTokens: 20 });
  return r.parsed;
}

/** Legacy compatibility: chat with tools (no receipts, no validation). */
export async function chatWithTools({ messages, tools, toolChoice = 'auto', lane = 'fast', maxTokens = 1400, runDir, trace }) {
  const base = (process.env.METERLESS_BASE_URL || '').replace(/\/+$/, '');
  const token = process.env.METERLESS_RUNTIME_TOKEN;
  const appId = process.env.WARRANT_METERLESS_APP_ID || 'warrant';
  const model = modelFor(lane);

  const body = JSON.stringify({ model, messages, tools, tool_choice: toolChoice, temperature: 0, max_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false } });
  let res;

  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'meterless-app': appId, 'meterless-scope': 'user', 'Content-Type': 'application/json' },
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
  
  // Record LLM request/response for cassette replay
  if (runDir) {
    const { record } = await import('./cassette.js');
    record(runDir, 'llm', { model, messages, tools, tool_choice: toolChoice, temperature: 0, max_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false } }, json);
  }
  
  // Emit trace
  if (trace && typeof trace.emit === 'function') {
    const receipt = {
      receiptId: json.meterless?.receipt_id ?? json.meterless?.receipt?.receipt_id ?? null,
      requestedModel: model,
      routedModel: json.meterless?.routed_model ?? json.meterless?.winning_route?.model ?? json.model ?? null,
      provider: json.meterless?.winning_route?.provider ?? json.meterless?.egress?.destination ?? null,
      latencyMs: json.meterless?.usage?.latency_ms ?? null,
      inputTokens: json.meterless?.usage?.input_tokens ?? null,
      outputTokens: json.meterless?.usage?.output_tokens ?? null,
      costUsd: json.meterless?.cost?.actual_usd ?? null,
      privacyPath: json.meterless?.privacy?.path ?? null,
      replayed: false,
    };
    trace.emit('llm', 'agent', `chatWithTools -> ${receipt.routedModel ?? model} (live, HTTP ${res.status}) ${receipt.latencyMs ?? '?'}ms`, {
      lane, purpose: 'chatWithTools', receipt,
    });
  }

  return {
    message: { role: 'assistant', content: message.content ?? '', ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) },
    model: json.model || model,
    durationMs: 0,
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
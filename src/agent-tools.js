/**
 * The investigation as a bounded tool loop.
 *
 * The model decides what to look up and how far back to go. Code decides what
 * that is allowed to mean:
 *   - whose data: the customer is fixed from the email match; no tool accepts
 *     a customer id,
 *   - how much: at most MAX_TOOL_CALLS searches, 10 charges per page, 365 days,
 *   - what counts: only charges and incidents returned by these tools can be
 *     cited, and the duplicate rule is re-checked against exactly that set.
 * Every tool is read-only. Refunds stay behind human approval in the graph.
 */
import { readFileSync } from 'node:fs';
import * as stripe from './adapters/stripe.js';
import * as github from './adapters/github.js';
import { sanitizeReport, enforceDuplicateRule } from './agent.js';
import { assembleCaseByRules } from './agent-rules.js';
import { parseJSONObject } from './llm.js';

export const MAX_TOOL_CALLS = 8;
const POLICY = readFileSync(new URL('./policy.md', import.meta.url), 'utf8');

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_charges',
      description:
        "List this customer's charges, newest first, up to 10 per call. " +
        'To look further back, call again with next_cursor from the previous result. ' +
        'Optionally bound by date (ISO dates). History is limited to the last 365 days.',
      parameters: {
        type: 'object',
        properties: {
          cursor: { type: ['string', 'null'], description: 'next_cursor from a previous search_charges result' },
          created_after: { type: ['string', 'null'], description: 'ISO date, inclusive' },
          created_before: { type: ['string', 'null'], description: 'ISO date, exclusive' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_incidents',
      description:
        'Find engineering incidents (GitHub issues labelled "incident") created in a date window, ' +
        'optionally filtered by keywords such as "retry duplicate invoice". Defaults to the last 30 days.',
      parameters: {
        type: 'object',
        properties: {
          since: { type: ['string', 'null'], description: 'ISO date' },
          until: { type: ['string', 'null'], description: 'ISO date' },
          keywords: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_finding',
      description: 'Finish the investigation. Call this exactly once, when you have enough evidence or nothing more to search.',
      parameters: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['duplicate', 'insufficient_evidence'] },
          charge_to_refund: { type: ['string', 'null'], description: 'the LATER charge of the duplicate pair, or null' },
          duplicate_of: { type: ['string', 'null'], description: 'the earlier, legitimate charge, or null' },
          grounds: { type: 'string', description: 'one sentence citing charge ids and any corroborating incident' },
          missing_evidence: { type: ['string', 'null'], description: 'what is absent; required when refusing' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: { source: { type: 'string', enum: ['stripe', 'github'] }, id: { type: 'string' }, detail: { type: 'string' } },
              required: ['source', 'id', 'detail'],
            },
          },
          uncertainty: { type: 'string' },
        },
        required: ['verdict', 'grounds', 'evidence', 'uncertainty'],
      },
    },
  },
];

export const FINISH = 'submit_finding';

const TOOL_NAMES = new Set(['search_charges', 'search_incidents', FINISH]);
const dropNulls = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== null && v !== undefined));

/**
 * Groq validates generated tool calls strictly and rejects the whole turn on a
 * mismatch, returning what the model tried in failed_generation. Recover the
 * intent instead of discarding the turn: strip nulls from a search, and treat
 * a verdict emitted under the wrong tool name as submit_finding.
 */
export function recoverToolCall(err) {
  const gen = err?.body?.error?.failed_generation;
  if (!gen) return null;
  let parsed;
  try { parsed = JSON.parse(gen); } catch {
    const m = String(gen).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { parsed = JSON.parse(m[0]); } catch { return null; }
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const calls = [];
  for (const [i, it] of items.entries()) {
    let name = it?.name;
    let args = it?.arguments ?? it?.parameters ?? (it?.verdict ? it : null);
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (args?.verdict) name = FINISH;
    if (!TOOL_NAMES.has(name)) continue;
    calls.push({ id: `recovered_${Date.now()}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(dropNulls(args)) } });
  }
  return calls.length ? { role: 'assistant', content: '', tool_calls: calls } : null;
}

const SCHEMA = 'Search as much as you need (at most 8 searches), then call submit_finding exactly once. Leave out arguments you do not need rather than sending null. Do not reply with plain text.';

export function initialMessages({ report, customer }) {
  return [
    { role: 'system', content: POLICY },
    {
      role: 'user',
      content: [
        `Today is ${new Date().toISOString().slice(0, 10)}.`,
        `Customer: ${customer.name}. Their charges are reachable only through search_charges.`,
        '',
        '<customer_report>',
        sanitizeReport(report),
        '</customer_report>',
        '',
        'Investigate with the tools, then answer.',
        SCHEMA,
      ].join('\n'),
    },
  ];
}

const compactCharge = (c) => ({
  id: c.id,
  amount: (c.amount / 100).toFixed(2) + ' ' + c.currency.toUpperCase(),
  status: c.status,
  created: c.created_iso,
  refunded: c.amount_refunded > 0,
  description: (c.description || '').slice(0, 120),
  billing_keys: c.billing_keys || [],
});

/** Run one tool call with the customer locked in. Returns { content, charges, incidents, summary }. */
export async function runTool(call, customerId) {
  let args = {};
  try { args = dropNulls(JSON.parse(call.function?.arguments || '{}')); } catch { args = {}; }
  const name = call.function?.name;

  if (name === 'search_charges') {
    const r = await stripe.searchCharges(customerId, args);
    return {
      name, args,
      charges: r.charges,
      incidents: [],
      summary: `${r.charges.length} charge${r.charges.length === 1 ? '' : 's'}${r.has_more ? ', more available' : ''}`,
      has_more: r.has_more,
      next_cursor: r.next_cursor,
      window: r.window,
      content: JSON.stringify({
        charges: r.charges.map(compactCharge),
        has_more: r.has_more,
        next_cursor: r.next_cursor,
        window: r.window,
        ...(r.charges.length === 0 && (args.created_after || args.created_before)
          ? { note: 'No charges in that date window. Charge dates may not match the customer\'s description: search without dates and page back with next_cursor.' }
          : {}),
        ...(r.has_more ? { note: 'Older charges exist. Call search_charges again with cursor=next_cursor to see them.' } : {}),
      }),
    };
  }
  if (name === 'search_incidents') {
    const r = await github.searchIncidents(args);
    return {
      name, args,
      charges: [],
      incidents: r.incidents.slice(0, 8),
      summary: `${Math.min(8, r.incidents.length)} incident${r.incidents.length === 1 ? '' : 's'} ${r.window.from}…${r.window.to}`,
      content: JSON.stringify({
        incidents: r.incidents.slice(0, 8).map((i) => ({ number: i.number, created: i.created_iso, title: i.title,
          coverage_start: i.coverage_start_iso || null, coverage_end: i.coverage_end_iso || null,
          body: i.body.replace(/\s+/g, ' ').slice(0, 120) })),
        shown: Math.min(8, r.incidents.length),
        matched: r.incidents.length,
        window: r.window,
      }),
    };
  }
  return { name, args, charges: [], incidents: [], summary: 'unknown tool', content: JSON.stringify({ error: `unknown tool ${name}` }) };
}

/**
 * Turn the model's final message into a finding, then enforce the duplicate
 * rule against the evidence the tools actually returned.
 */
export function decide(finalMessage, chargesSeen, incidentsSeen) {
  let p = null;
  const call = (finalMessage?.tool_calls || []).find((t) => t.function?.name === FINISH);
  try {
    p = call ? JSON.parse(call.function.arguments || '{}') : parseJSONObject(finalMessage?.content || '');
  } catch {
    p = null;
  }
  if (!p || !['duplicate', 'insufficient_evidence'].includes(p.verdict)) {
    const finding = {
      verdict: 'insufficient_evidence', outcome: 'insufficient_evidence', charge_to_refund: null, duplicate_of: null,
      grounds: 'The investigation did not reach a usable conclusion.',
      missing_evidence: 'The agent did not return a valid verdict, so no correction is proposed.',
      evidence: chargesSeen.map((c) => ({ source: 'stripe', id: c.id, detail: `${(c.amount / 100).toFixed(2)} ${c.currency.toUpperCase()}` })),
      uncertainty: 'Model output could not be parsed.',
    };
    return { finding, guard: { overridden: true, reason: 'the model did not return a valid verdict' } };
  }
  if (!chargesSeen.length && p.verdict === 'duplicate') {
    return {
      finding: { ...p, verdict: 'insufficient_evidence', outcome: 'insufficient_evidence', charge_to_refund: null, duplicate_of: null, missing_evidence: 'No charges were examined.' },
      guard: { overridden: true, reason: 'the model proposed a refund without searching any charges' },
    };
  }
  const g = enforceDuplicateRule(p, chargesSeen, incidentsSeen);
  return { finding: g.finding, guard: { overridden: g.overridden, reason: g.reason ?? null } };
}

/** Outage fallback: code gathers a fixed evidence set and the rules engine judges it. */
export async function rulesInvestigation(customerId) {
  const charges = [];
  let cursor;
  let chargesComplete = false;
  for (let i = 0; i < 5; i++) {
    const r = await stripe.searchCharges(customerId, { cursor });
    charges.push(...r.charges);
    if (!r.next_cursor) { chargesComplete = true; break; }
    cursor = r.next_cursor;
  }
  const oldest = charges.reduce((min, c) => Math.min(min, c.created), Math.floor(Date.now() / 1000));
  const { incidents } = await github.searchIncidents({
    since: new Date((oldest - 86400) * 1000).toISOString(),
    until: new Date().toISOString(),
  });
  return { charges, incidents, chargesComplete, finding: assembleCaseByRules({ charges, incidents }) };
}

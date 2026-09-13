import { outcomeFor } from '../outcomes.js';
import { sqliteProviderEnabled, createDemoNotification, updateDemoNotification } from '../demo-store.js';
/**
 * Raw fetch rather than the SDK, so we can see HTTP status, Retry-After and
 * twin stub markers. Slack returns HTTP 200 with ok:false — every call must
 * check the `ok` field, not the status code.
 *
 * Set SLACK_API_URL to an Arga twin base URL to target the twin instead.
 */
const BASE = () => (process.env.SLACK_API_URL || 'https://slack.com').replace(/\/$/, '');
const CHANNEL = () => process.env.SLACK_CHANNEL || '#billing-approvals';

export class SlackError extends Error {
  constructor(msg, { status, code, retryAfter } = {}) {
    super(msg);
    this.name = 'SlackError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.definitiveRejection = status === 429 || (status >= 400 && status < 500 && status !== 408) || (status === 200 && Boolean(code) && !['unknown','internal_error','fatal_error','request_timeout'].includes(code));
    this.retryable = status === 429 || code === 'ratelimited' || code === 'rate_limited';
  }
}

async function call(method, body = {}) {
  const res = await fetch(`${BASE()}/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });

  let json = {};
  try { json = await res.json(); } catch {}

  if (res.headers.get('x-twin-stub') === 'true' || json._twin_stub === true) {
    throw new SlackError(`${method} is STUBBED on this twin — refusing to trust it`, {
      status: res.status, code: 'twin_stub',
    });
  }

  if (json.ok !== true) {
    throw new SlackError(`${method}: ${json.error || 'unknown'} (HTTP ${res.status})`, {
      status: res.status,
      code: json.error,
      retryAfter: Number(res.headers.get('retry-after')) || undefined,
    });
  }

  return json;
}

const money = (cents, cur) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: (cur || 'usd').toUpperCase() })
    .format(cents / 100);

export async function postProposal(plan, approveUrl) {
  if (sqliteProviderEnabled()) return createDemoNotification('proposal', { plan, approveUrl });
  const refunds = plan.refunds || [{ charge_id: plan.charge_id, amount: plan.amount, currency: plan.currency, duplicate_of: plan.duplicate_of }];
  const total = plan.total_amount ?? plan.amount;
  const r = await call('chat.postMessage', {
    channel: CHANNEL(),
    text: `${refunds.length > 1 ? 'Batch refund' : 'Refund'} proposed: ${money(total, refunds[0].currency)} — ${plan.customer_name}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Refund proposed — awaiting approval' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Customer*\n${plan.customer_name}` },
          { type: 'mrkdwn', text: `*Total*\n${money(total, refunds[0].currency)}` },
          { type: 'mrkdwn', text: `*Refunds*\n${refunds.map(x => `\`${x.charge_id}\` (${money(x.amount, x.currency)})`).join('\n')}` },
          { type: 'mrkdwn', text: `*Keep*\n\`${refunds[0].duplicate_of}\`` },
        ],
      },
      { type: 'section', text: { type: 'mrkdwn', text: `*Grounds*\n${plan.grounds}` } },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Case #${plan.case_id} · plan \`${plan.plan_id}\` · approve: ${approveUrl}` }],
      },
    ],
  });
  return { ts: r.ts, channel: r.channel };
}

export async function postRefusal(caseNumber, customerName, missing, caseUrl, finding) {
  if (sqliteProviderEnabled()) return createDemoNotification('refusal', { caseNumber, customerName, missing, caseUrl, finding });
  const r = await call('chat.postMessage', {
    channel: CHANNEL(),
    text: `No action taken — ${customerName}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `No refund proposed — ${outcomeFor(finding).label}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Customer*\n${customerName}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Missing evidence*\n${missing}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Case #${caseNumber} · ${caseUrl}` }] },
    ],
  });
  return { ts: r.ts, channel: r.channel };
}

export async function updateApplied(channel, ts, plan, refundInput, approver) {
  if (sqliteProviderEnabled()) return updateDemoNotification(channel, ts, 'applied', { plan, refundInput, approver });
  const refunds = Array.isArray(refundInput) ? refundInput : [refundInput];
  const total = plan.total_amount ?? plan.amount;
  const currency = plan.refunds?.[0]?.currency ?? plan.currency;
  const r = await call('chat.update', {
    channel, ts,
    text: `${refunds.length > 1 ? 'Batch refund' : 'Refund'} applied: ${money(total, currency)} — ${plan.customer_name}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Refund applied and verified' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Customer*\n${plan.customer_name}` },
          { type: 'mrkdwn', text: `*Refunded*\n${money(total, currency)}` },
          { type: 'mrkdwn', text: `*Refunds*\n${refunds.map(r => `\`${r.id}\``).join('\n')}` },
          { type: 'mrkdwn', text: `*Approved by*\n${approver}` },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Verified against Stripe · amount_refunded matches · case #${plan.case_id}` }] },
    ],
  });
  return { ts: r.ts };
}

export async function updateDeclined(channel, ts, plan, approver, reason) {
  if (sqliteProviderEnabled()) return updateDemoNotification(channel, ts, 'declined', { plan, approver, reason });
  const amount = plan.total_amount ?? plan.amount;
  const currency = plan.refunds?.[0]?.currency ?? plan.currency;
  const r = await call('chat.update', {
    channel, ts,
    text: `Refund declined: ${money(amount, currency)} — ${plan.customer_name}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Refund declined — no money moved' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Customer*\n${plan.customer_name}` },
          { type: 'mrkdwn', text: `*Proposed*\n${money(amount, currency)}` },
          { type: 'mrkdwn', text: `*Declined by*\n${approver}` },
          { type: 'mrkdwn', text: `*Reason*\n${reason || '_none given_'}` },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Case #${plan.case_id} · plan \`${plan.plan_id}\`` }] },
    ],
  });
  return { ts: r.ts };
}

export const raw = call;

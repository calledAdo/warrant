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
  const r = await call('chat.postMessage', {
    channel: CHANNEL(),
    text: `Refund proposed: ${money(plan.amount, plan.currency)} — ${plan.customer_name}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Refund proposed — awaiting approval' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Customer*\n${plan.customer_name}` },
          { type: 'mrkdwn', text: `*Amount*\n${money(plan.amount, plan.currency)}` },
          { type: 'mrkdwn', text: `*Refund*\n\`${plan.charge_id}\`` },
          { type: 'mrkdwn', text: `*Duplicate of*\n\`${plan.duplicate_of}\`` },
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

export async function postRefusal(caseNumber, customerName, missing, caseUrl) {
  const r = await call('chat.postMessage', {
    channel: CHANNEL(),
    text: `No action taken — ${customerName}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'No refund proposed — evidence insufficient' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Customer*\n${customerName}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Missing evidence*\n${missing}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Case #${caseNumber} · ${caseUrl}` }] },
    ],
  });
  return { ts: r.ts, channel: r.channel };
}

export async function updateApplied(channel, ts, plan, refund, approver) {
  const r = await call('chat.update', {
    channel, ts,
    text: `Refund applied: ${money(plan.amount, plan.currency)} — ${plan.customer_name}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Refund applied and verified' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Customer*\n${plan.customer_name}` },
          { type: 'mrkdwn', text: `*Refunded*\n${money(refund.amount, plan.currency)}` },
          { type: 'mrkdwn', text: `*Refund*\n\`${refund.id}\`` },
          { type: 'mrkdwn', text: `*Approved by*\n${approver}` },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Verified against Stripe · amount_refunded matches · case #${plan.case_id}` }] },
    ],
  });
  return { ts: r.ts };
}

export const raw = call;

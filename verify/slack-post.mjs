/**
 * Proves: bot token works, we can post a proposal AND update that same message
 * later (the pattern the whole approval UX depends on), and that we correctly
 * treat `ok: false` as a failure even though Slack returns HTTP 200.
 *
 * Set SLACK_API_URL to an Arga twin base URL to run this against a twin instead.
 * Run: npm run verify:slack
 */
import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = process.env.SLACK_CHANNEL;
const API_URL = process.env.SLACK_API_URL || undefined;

const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m  ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

if (!TOKEN || !CHANNEL) {
  console.error('\nSLACK_BOT_TOKEN and SLACK_CHANNEL must be set in .env\n');
  process.exit(1);
}

const slack = new WebClient(TOKEN, API_URL ? { slackApiUrl: API_URL } : {});

/**
 * The rule the reliability brief depends on: Slack returns HTTP 200 with
 * ok:false. The SDK throws on that, but a raw fetch would not. Any adapter we
 * write must check the `ok` field, not the status code.
 */
async function call(method, args) {
  const res = await slack.apiCall(method, args);
  if (!res.ok) throw new Error(`${method} returned ok:false — ${res.error}`);
  return res;
}

async function main() {
  if (API_URL) note(`running against TWIN at ${API_URL}`);
  else note('running against REAL Slack');

  head('0. Auth');
  const auth = await call('auth.test', {});
  pass(`bot ${auth.user} in team ${auth.team}`);

  head('1. Post the proposal (what the approver sees)');
  const posted = await call('chat.postMessage', {
    channel: CHANNEL,
    text: 'Refund proposed: $49.00 to Northwind Trading Co.',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Refund proposed — awaiting approval' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Customer*\nNorthwind Trading Co.' },
          { type: 'mrkdwn', text: '*Amount*\n$49.00 USD' },
          { type: 'mrkdwn', text: '*Charge*\n`ch_yyy`' },
          { type: 'mrkdwn', text: '*Grounds*\nDuplicate of `ch_xxx`, 41s apart' },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Corroborated by billing incident #1 · expires in 15 min' }] },
    ],
  });
  pass(`message posted ts=${posted.ts}`);

  head('2. Update that same message (post-execution state)');
  const updated = await call('chat.update', {
    channel: posted.channel,
    ts: posted.ts,
    text: 'Refund applied: $49.00 to Northwind Trading Co.',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Refund applied and verified' } },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '`re_xxx` · `amount_refunded=4900` · approved by *you* at ' + new Date().toISOString() },
      },
    ],
  });
  pass(`same ts updated (${updated.ts === posted.ts ? 'ts unchanged — correct' : 'TS CHANGED — unexpected'})`);

  head('3. ok:false is treated as a failure, not a success');
  let caught = false;
  try {
    await call('chat.update', { channel: posted.channel, ts: '1111111111.000000', text: 'should fail' });
  } catch (err) {
    caught = true;
    pass(`bad ts rejected: ${err.message}`);
  }
  if (!caught) fail('A bogus update did NOT throw. Your adapter would report a phantom success.');

  head('4. Stub detection (only meaningful against a twin)');
  if (API_URL) {
    const raw = await fetch(`${API_URL.replace(/\/$/, '')}/api/auth.test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const stubHeader = raw.headers.get('x-twin-stub');
    const body = await raw.json().catch(() => ({}));
    if (stubHeader === 'true' || body._twin_stub) {
      fail('This endpoint is STUBBED on the twin — do not build on it.');
    } else {
      pass('no stub markers on auth.test');
    }
    note('Repeat this check against chat.postMessage and chat.update before relying on them.');
  } else {
    note('skipped — set SLACK_API_URL to a twin to check for _twin_stub markers');
  }

  console.log(`\n  \x1b[32mSlack path holds.\x1b[0m Check ${CHANNEL} — one message, edited in place.\n`);
}

main().catch((err) => {
  console.error(`\n\x1b[31mFAILED\x1b[0m ${err.message}`);
  console.error('  invalid_auth → bad token. missing_scope → add chat:write.');
  console.error('  channel_not_found → invite the bot to the channel first.\n');
  process.exit(1);
});

import { createRun, investigate, approve, decline, execute, runs } from './run.js';
import * as stripe from './adapters/stripe.js';
import * as complaints from './complaints.js';

const httpError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

export async function submitRefundRequest({ email, body }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const report = String(body || '').trim();
  if (!cleanEmail || !report) throw httpError('Email and description are required.', 400);
  if (report.length > 2000) throw httpError('Please keep the description under 2,000 characters.', 400);
  const customer = await stripe.findCustomerByEmail(cleanEmail).catch(() => null);
  if (!customer) {
    throw httpError('We could not find an account for that email address. Check the address and try again.', 404);
  }
  const complaint = complaints.create({ email: cleanEmail, body: report, customer });
  const run = createRun(report, customer.id);
  complaints.attachRun(complaint.id, run.id);
  return { complaint: complaints.get(complaint.id), run };
}

export async function investigateRefundRequest(run) {
  try {
    return await investigate(run);
  } catch (error) {
    run.status = 'error';
    run.error = error.message;
    run.emit('update', run.snapshot());
    throw error;
  }
}

export function approveRefundRequest({ runId, planId, approver = 'ops@warrant.test' }) {
  const run = runs.get(runId);
  if (!run) throw httpError('no such run', 404);
  if (!run.plan) throw httpError('run has no plan', 409);
  if (planId && run.plan.plan_id !== planId) throw httpError('plan changed since it was shown', 409);
  approve(run, approver);
  return run;
}

export async function executeApprovedRefund(run) {
  try {
    return await execute(run);
  } catch (error) {
    run.status = 'error';
    run.error = error.message;
    run.emit('update', run.snapshot());
    throw error;
  }
}

export async function declineRefundRequest({ runId, approver = 'ops@warrant.test', reason = '' }) {
  const run = runs.get(runId);
  if (!run?.plan) throw httpError('no plan on that run', 404);
  if (run.status !== 'awaiting_approval') throw httpError('not awaiting a decision', 409);
  return decline(run, approver, reason);
}

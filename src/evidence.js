import { nowMs } from './clock.js';
/**
 * Warrant evidence layer — queries Zetaris for billing history, engineering incidents, and case history
 * Replaces direct SaaS SDK calls for READ operations. Writes that move money stay on existing Stripe path.
 */
import { ZetarisBackend } from "./zetaris.js";
// Trace is imported dynamically where needed; we only use the emit method

/** @typedef {Object} BillingRecord
 * @property {number} id
 * @property {string} customer_id
 * @property {string} stripe_charge_id
 * @property {number} amount
 * @property {string} currency
 * @property {string} status
 * @property {string} created_at
 * @property {boolean} refunded
 * @property {string|null} refund_id
 * @property {string|null} refunded_at
 * @property {string|null} description
 * @property {string|null} metadata
 */

/** @typedef {Object} IncidentRecord
 * @property {number} id
 * @property {number} github_issue_number
 * @property {string} title
 * @property {string} state
 * @property {string[]} labels
 * @property {string} created_at
 * @property {string|null} closed_at
 * @property {string|null} body
 * @property {string[]} assignees
 */

/** @typedef {Object} CaseRecord
 * @property {number} id
 * @property {string} case_id
 * @property {string} customer_id
 * @property {string} complaint_text
 * @property {string} finding
 * @property {string|null} finding_reason
 * @property {string|null} proposal
 * @property {string|null} approver_decision
 * @property {string|null} approver_reason
 * @property {string|null} decided_at
 * @property {string} created_at
 */

export class EvidenceService {
  /**
   * @param {string} [runDir]
   */
  constructor(runDir) {
    this.backend = new ZetarisBackend(runDir);
  }

  /**
   * @param {"evidence"|"history"} agent
   */
  forAgent(agent) {
    return this.backend.forAgent(agent);
  }

  /**
   * @param {string} customerId
   * @param {{ trace: Trace }} ctx
   * @returns {Promise<BillingRecord[]>}
   */
  async searchCharges(customerId, ctx) {
    const agent = this.forAgent("evidence");
    const sql = `SELECT * FROM warrant_db.billing_history WHERE customer_id = '${customerId}' ORDER BY created_at DESC LIMIT 50`;
    const rows = await agent.query(sql, { agent: "evidence", purpose: "search_charges", trace: ctx.trace });
    return rows.map(r => ({
      id: Number(r.id),
      customer_id: r.customer_id,
      stripe_charge_id: r.stripe_charge_id,
      amount: Number(r.amount),
      currency: r.currency,
      status: r.status,
      created_at: r.created_at,
      refunded: r.refunded === "true" || r.refunded === "1",
      refund_id: r.refund_id,
      refunded_at: r.refunded_at,
      description: r.description,
      metadata: r.metadata,
    }));
  }

  /**
   * @param {{ trace: Trace }} ctx
   * @param {number} [sinceDays]
   * @returns {Promise<IncidentRecord[]>}
   */
  async searchIncidents(ctx, sinceDays = 365) {
    const agent = this.forAgent("evidence");
    const since = new Date(nowMs() - sinceDays * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const sql = `SELECT * FROM warrant_db.engineering_incidents WHERE created_at >= '${since}' ORDER BY created_at DESC LIMIT 100`;
    const rows = await agent.query(sql, { agent: "evidence", purpose: "search_incidents", trace: ctx.trace });
    return rows.map(r => ({
      id: Number(r.id),
      github_issue_number: Number(r.github_issue_number),
      title: r.title,
      state: r.state,
      labels: r.labels ? JSON.parse(r.labels) : [],
      created_at: r.created_at,
      closed_at: r.closed_at,
      body: r.body,
      assignees: r.assignees ? JSON.parse(r.assignees) : [],
    }));
  }

  /**
   * @param {string} customerId
   * @param {{ trace: Trace }} ctx
   * @returns {Promise<CaseRecord[]>}
   */
  async searchCaseHistory(customerId, ctx) {
    const agent = this.forAgent("history");
    const sql = `SELECT * FROM warrant_db.case_history WHERE customer_id = '${customerId}' ORDER BY created_at DESC LIMIT 20`;
    const rows = await agent.query(sql, { agent: "history", purpose: "search_case_history", trace: ctx.trace });
    return rows.map(r => ({
      id: Number(r.id),
      case_id: r.case_id,
      customer_id: r.customer_id,
      complaint_text: r.complaint_text,
      finding: r.finding,
      finding_reason: r.finding_reason,
      proposal: r.proposal,
      approver_decision: r.approver_decision,
      approver_reason: r.approver_reason,
      decided_at: r.decided_at,
      created_at: r.created_at,
    }));
  }

  /**
   * Record a decided case to the Zetaris case_history table.
   * @param {Omit<CaseRecord, "id" | "created_at">} caseRecord
   * @param {{ trace: Trace }} ctx
   * @returns {Promise<void>}
   */
  async recordCase(caseRecord, ctx) {
    // Runtime Zetaris principals are read-only by design, so outcomes are written to the
    // warrant PostgreSQL database that Zetaris serves; the next read through Zetaris sees them.
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      host: process.env.WARRANT_PG_HOST || '127.0.0.1',
      port: Number(process.env.WARRANT_PG_PORT || 55433),
      database: 'warrant',
      user: process.env.WARRANT_DB_USER,
      password: process.env.WARRANT_DB_PASSWORD,
    });
    const now = new Date().toISOString();
    await client.connect();
    try {
      await client.query(
        `INSERT INTO case_history (case_id, customer_id, complaint_text, finding, finding_reason, proposal, approver_decision, approver_reason, decided_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (case_id) DO UPDATE SET finding = EXCLUDED.finding, finding_reason = EXCLUDED.finding_reason,
           proposal = EXCLUDED.proposal, approver_decision = EXCLUDED.approver_decision,
           approver_reason = EXCLUDED.approver_reason, decided_at = EXCLUDED.decided_at`,
        [caseRecord.case_id, caseRecord.customer_id, caseRecord.complaint_text, caseRecord.finding,
         caseRecord.finding_reason ?? null, caseRecord.proposal == null ? null : typeof caseRecord.proposal === 'string' ? caseRecord.proposal : JSON.stringify(caseRecord.proposal),
         caseRecord.approver_decision ?? null, caseRecord.approver_reason ?? null, caseRecord.decided_at || now, now],
      );
    } finally {
      await client.end();
    }
    ctx.trace.emit("evidence", "history", "Recorded case outcome to the warrant database", { case_id: caseRecord.case_id, customer_id: caseRecord.customer_id });
  }

  async close() {
    await this.backend.close();
  }
}
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
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
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
    const agent = this.forAgent("history");
    const now = new Date().toISOString();
    const decidedAt = caseRecord.decided_at || now;
    const findingReason = caseRecord.finding_reason ? `'${caseRecord.finding_reason.replace(/'/g, "''")}'` : 'NULL';
    const proposal = caseRecord.proposal ? `'${JSON.stringify(caseRecord.proposal).replace(/'/g, "''")}'` : 'NULL';
    const approverDecision = caseRecord.approver_decision ? `'${caseRecord.approver_decision.replace(/'/g, "''")}'` : 'NULL';
    const approverReason = caseRecord.approver_reason ? `'${caseRecord.approver_reason.replace(/'/g, "''")}'` : 'NULL';
    
    const sql = `INSERT INTO warrant_db.case_history 
      (case_id, customer_id, complaint_text, finding, finding_reason, proposal, approver_decision, approver_reason, decided_at, created_at)
      VALUES 
      ('${caseRecord.case_id.replace(/'/g, "''")}', 
       '${caseRecord.customer_id.replace(/'/g, "''")}', 
       '${caseRecord.complaint_text.replace(/'/g, "''")}', 
       '${caseRecord.finding.replace(/'/g, "''")}', 
       ${findingReason}, 
       ${proposal}, 
       ${approverDecision}, 
       ${approverReason}, 
       '${decidedAt}', 
       '${now}')`;
    
    await agent.query(sql, { agent: "history", purpose: "record_case", trace: ctx.trace });
    ctx.trace.emit("evidence", "history", "Recorded case to Zetaris", { case_id: caseRecord.case_id, customer_id: caseRecord.customer_id });
  }

  async close() {
    await this.backend.close();
  }
}
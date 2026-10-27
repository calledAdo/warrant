// Warrant Zetaris backend — evidence layer over Zetaris REST SQL
// Pattern adapted from Lotline's src/data/zetaris.ts
import { randomUUID } from "node:crypto";
import { record, replay } from "./cassette.js";
// Trace is imported dynamically where needed; we only use the emit method
import { Principal } from "./evidence-policy.js";
import { isPrincipal, principalName, refuse, checkQuery } from "./evidence-policy.js";

/** @typedef {Object} ZetarisResult
 * @property {string[]} headers
 * @property {(string|null)[][]} data
 */

export class ZetarisBackend {
  constructor(runDir, principal) {
    this.name = "zetaris";
    this.dialect = "spark";
    this.token = undefined;
    this.loginPending = undefined;
    this.children = new Map();
    this.runDir = runDir;
    this.principal = principal;
  }

  /**
   * @param {string} agent
   */
  forAgent(agent) {
    if (!isPrincipal(agent)) refuse(agent, "unknown principal");
    if (this.principal && this.principal !== agent) refuse(this.principal, "cannot switch principal");
    if (this.principal) return this;
    if (!this.children.has(agent)) this.children.set(agent, new ZetarisBackend(this.runDir, agent));
    return this.children.get(agent);
  }

  async credential() {
    if (!this.principal) throw new Error("Zetaris requires a bound agent principal");
    const prefix = `ZETARIS_WR_${this.principal.toUpperCase()}`;
    if (process.env[`${prefix}_API_KEY`]) return process.env[`${prefix}_API_KEY`];
    if (this.token) return this.token;
    if (!this.loginPending) this.loginPending = (async () => {
      const response = await fetch(`${process.env.ZETARIS_REST_URL}/auth/login`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${process.env[`${prefix}_USER`]}:${process.env[`${prefix}_PASSWORD`]}`).toString("base64")}`,
          "X-Org-ID": process.env.ZETARIS_ORG_ID ?? "1",
          "X-Request-ID": randomUUID(),
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Zetaris login for ${this.principal}: HTTP ${response.status}. Run npm run setup:zetaris; no administrator fallback is allowed.`);
      const body = await response.json();
      if (!body.idToken) throw new Error(`Zetaris login for ${this.principal} returned no idToken`);
      this.token = body.idToken;
      return this.token;
    })().finally(() => { this.loginPending = undefined; });
    return this.loginPending;
  }

  async run(sql) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${process.env.ZETARIS_REST_URL}/sql-editor/sqls/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.credential()}`,
          "X-Org-ID": process.env.ZETARIS_ORG_ID ?? "1",
          "X-Request-ID": randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: 10000 }),
        signal: AbortSignal.timeout(Number(process.env.ZETARIS_TIMEOUT_MS ?? 120000)),
      });
      if (response.status === 401 && attempt === 0) { this.token = undefined; continue; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok && attempt === 0 && (response.status >= 500 || /HTTP response code: 50[0234]/.test(String(body.msg ?? "")))) {
        await new Promise(resolve => setTimeout(resolve, 500)); continue;
      }
      if (!response.ok) throw new Error(`Zetaris HTTP ${response.status}: ${String(body.msg ?? "query failed").split("\n\tat")[0]}`);
      return { headers: body.headers ?? [], data: body.data ?? [] };
    }
    throw new Error("Zetaris authentication retry exhausted");
  }

  async sources() {
    return this.principal
      ? Object.entries({ evidence: ["warrant_db.billing_history", "warrant_db.engineering_incidents"], history: ["warrant_db.case_history"] })
          .filter(([k]) => k === this.principal)
          .flatMap(([, v]) => v.map(t => ({ table: t })))
      : [];
  }

  /**
   * @param {string} table
   * @param {{ trace: Trace }} [ctx]
   */
  async describe(table, ctx) {
    if (!this.principal) return this.forAgent("evidence").describe(table, ctx);
    checkQuery(this.principal, `SELECT * FROM ${table} LIMIT 0`, ctx?.trace);
    let r;
    try { r = await this.run(`SELECT * FROM ${table} LIMIT 0`); }
    catch (err) {
      const error = String(err.message);
      if (/denied|permission|not authorized|unauthori[sz]ed|forbidden|privilege|HTTP 403/i.test(error)) refuse(this.principal, error, ctx?.trace);
      throw err;
    }
    return r.headers.map(name => ({ name, type: "unknown" }));
  }

  /**
   * @param {string} sql
   * @param {{ agent: string; purpose: string; trace: Trace }} ctx
   */
  async query(sql, ctx) {
    if (!isPrincipal(ctx.agent)) refuse(ctx.agent, "unknown principal", ctx.trace);
    if (!this.principal) return this.forAgent(ctx.agent).query(sql, ctx);
    if (ctx.agent !== this.principal) refuse(this.principal, "query agent does not match bound principal", ctx.trace);
    checkQuery(this.principal, sql, ctx.trace);
    const principal = principalName(this.principal);
    const t0 = Date.now();
    if (process.env.SAMPLE_MODE === "true") {
      // Offline: the rows Zetaris returned for this principal and SQL in the recorded live run.
      const rows = replay("sql", { principal, sql }, this.runDir);
      ctx.trace.emit("sql", ctx.agent, `${ctx.purpose}: ${rows.length} rows replayed from the Zetaris recording`, { principal, backend: "zetaris-replay", sql, rows: rows.length });
      return rows;
    }
    let r;
    try { r = await this.run(sql); }
    catch (err) {
      const error = String(err.message);
      if (/denied|permission|not authorized|unauthori[sz]ed|forbidden|privilege|HTTP 403/i.test(error)) refuse(this.principal, error, ctx.trace);
      ctx.trace.emit("sql", ctx.agent, `${ctx.purpose}: Zetaris query failed`, { principal, backend: "zetaris", sql, rows: 0, error });
      throw err;
    }
    const rows = r.data.map(values => Object.fromEntries(r.headers.map((h, i) => [h, values[i] == null ? null : String(values[i])])));
    if (this.runDir) record(this.runDir, "sql", { principal, sql }, rows);
    ctx.trace.emit("sql", ctx.agent, `${ctx.purpose}: ${rows.length} rows from Zetaris in ${Date.now() - t0}ms`, { principal, backend: "zetaris", sql, rows: rows.length, sample: rows.slice(0, 3) });
    return rows;
  }

  async close() { this.token = undefined; for (const child of this.children.values()) await child.close(); }
}
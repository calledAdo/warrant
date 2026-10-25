// Trace is imported dynamically where needed; we only use the emit method

const AGENT_TABLES = {
  evidence: ["warrant_db.billing_history", "warrant_db.engineering_incidents"],
  history: ["warrant_db.case_history"],
};

/** @typedef {keyof typeof AGENT_TABLES} Principal */
export const Principal = Object.freeze({ evidence: "evidence", history: "history" });

export function isPrincipal(agent) {
  return Object.hasOwn(AGENT_TABLES, agent);
}

export function principalName(agent) {
  return `warrant_${agent}`;
}

export class PolicyRefusal extends Error {
  constructor(principal, reason) {
    super(`Data access refused for ${principal}: ${reason}`);
    this.name = "PolicyRefusal";
    this.principal = principal;
  }
}

export function refuse(agent, reason, trace) {
  trace?.emit("policy", agent, `Data access refused: ${reason}`, {
    principal: isPrincipal(agent) ? principalName(agent) : agent,
    allowed: false,
    reason,
  });
  throw new PolicyRefusal(agent, reason);
}

export function checkTable(agent, table, trace) {
  if (!isPrincipal(agent) || !(AGENT_TABLES[agent] || []).includes(table.toLowerCase())) {
    refuse(agent, `SELECT on ${table}`, trace);
  }
}

export function checkQuery(agent, sql, trace) {
  if (!isPrincipal(agent)) refuse(agent, "unknown principal", trace);
  const stripped = sql.replace(/'(?:''|[^'])*'/g, "''");
  if (/[';`"\\]|--|\/\*|\*\//.test(stripped.replaceAll("''", "")) || !/^\s*(SELECT|DESCRIBE|INSERT)\b/i.test(stripped)) {
    refuse(agent, "only a single generated SELECT, DESCRIBE, or INSERT is permitted", trace);
  }
  if (/^\s*DESCRIBE\s+([\w]+\.[\w]+)\s*$/i.test(stripped)) {
    checkTable(agent, stripped.trim().split(/\s+/)[1], trace);
    return;
  }
  // Allow INSERT only for history principal on case_history table
  const isInsert = /^\s*INSERT\b/i.test(stripped);
  if (isInsert) {
    if (agent !== "history") refuse(agent, "INSERT only permitted for history principal", trace);
    if (!/INTO\s+warrant_db\.case_history\b/i.test(stripped)) refuse(agent, "INSERT only permitted on warrant_db.case_history", trace);
    return;
  }
  if (/\b(TABLE|PIVOT|UNPIVOT|INTO|COPY|EXPORT|IMPORT|INSTALL|LOAD|ATTACH|DETACH|PRAGMA|CALL|SET|UPDATE|DELETE|CREATE|DROP|ALTER|EXECUTE|PREPARE)\b/i.test(stripped)) {
    refuse(agent, "unsupported read syntax", trace);
  }
  const functions = new Set(["cast", "count", "sum", "concat", "lpad", "replace", "split", "split_part", "lower", "upper", "coalesce", "in", "select", "varchar", "jsonb_extract", "to_timestamp", "now"]);
  for (const m of stripped.matchAll(/\b([a-z_][\w]*)\s*\(/gi)) {
    if (!functions.has(m[1].toLowerCase())) {
      refuse(agent, `unsupported SQL function ${m[1]}`, trace);
    }
  }
  for (const m of stripped.matchAll(/\b(?:FROM|JOIN)\s+([^\s,)]+)/gi)) {
    if (!/^[a-z_]\w*\.[a-z_]\w*$/i.test(m[1])) {
      refuse(agent, "source must be a registered schema.table", trace);
    }
    checkTable(agent, m[1], trace);
  }
  let depth = 0;
  const inFrom = new Set();
  for (const token of stripped.match(/\w+|[(),]/g) ?? []) {
    if (token === "(") { depth++; continue; }
    if (token === ")") { inFrom.delete(depth); depth--; continue; }
    if (/^FROM$/i.test(token)) inFrom.add(depth);
    if (/^(WHERE|GROUP|ORDER|HAVING|LIMIT|UNION)$/i.test(token)) inFrom.delete(depth);
    if (token === "," && inFrom.has(depth)) {
      refuse(agent, "comma joins are not permitted", trace);
    }
  }
}
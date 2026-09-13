export type RunStatus = 'received' | 'running' | 'awaiting_approval' | 'approved' | 'executing' | 'complete' | 'partial' | 'refused' | 'declined' | 'error';
export interface Complaint {
  id: string; created_at: string; email: string; body: string; customer_name: string | null;
  customer_id: string; run_id: string | null; status: RunStatus; amount: number | null; currency: string;
}
export interface CustomerReport {
  id: string; created_at: string; email: string; body: string; customer_name: string | null;
  stage: number; stage_label: string; note: string;
  outcome: null | { kind: 'refund' | 'no_action'; amount?: number | null; currency?: string; text: string };
}
export interface Evidence { source: string; id: string; detail: string }
export interface Finding {
  verdict: 'duplicate' | 'not_duplicate'; charge_to_refund?: string; duplicate_of?: string;
  grounds: string; missing_evidence?: string; uncertainty?: string; evidence: Evidence[];
}
export interface Plan {
  plan_id: string; amount: number; currency: string; charge_id: string; duplicate_of: string;
  customer_id: string; action: string; expires_at: string; created_at: string;
}
export interface Step {
  key: string; label: string; state: 'idle' | 'active' | 'done' | 'failed' | 'refused'; detail?: string;
  durationMs?: number; attempts?: { skipped?: boolean; state: string }[];
}
export interface Run {
  id: string; status: RunStatus; steps: Step[]; plan: Plan | null; finding: Finding | null;
  llm: null | { rules: boolean; model: string; ms: number; inTok: number; outTok: number };
  guard: null | { overridden?: boolean; reason?: string };
  incidents: null | { number: number; title: string }[];
  caseNumber: number | null; caseUrl: string | null; pending: { step: string; error: string }[];
  approver: string | null; declineReason: string | null; error: string | null;
  engine: { framework: string; next: string[]; checkpoints: number; interrupted?: boolean };
  expiresIn: number | null;
}
export interface Config { tracing: boolean; twin: boolean; repo?: string; model: string; engine: string }
export interface Operation { op_key: string; step: string; status: string; result: string | null; error: string | null; created_at: string }

import type { RunStatus } from '@/lib/types';

export const statuses: Record<RunStatus, { label: string; tone: string }> = {
  received: { label: 'Received', tone: 'neutral' }, running: { label: 'Investigating', tone: 'blue' },
  awaiting_approval: { label: 'Needs review', tone: 'amber' }, approved: { label: 'Approved', tone: 'blue' },
  executing: { label: 'Refunding', tone: 'blue' }, complete: { label: 'Refunded', tone: 'green' },
  partial: { label: 'Follow-up pending', tone: 'amber' }, refused: { label: 'No duplicate', tone: 'neutral' },
  declined: { label: 'Declined', tone: 'neutral' }, error: { label: 'Needs attention', tone: 'red' },
};
export function StatusBadge({ status }: { status: RunStatus }) {
  const { label, tone } = statuses[status] ?? { label: 'Unknown', tone: 'neutral' };
  return <span className={`badge badge-${tone}`}><span className="status-dot" />{label}</span>;
}

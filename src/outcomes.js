export const OUTCOMES = {
  duplicate: { label: 'Duplicate confirmed', text: 'A duplicate charge was found. A full refund is proposed for review.' },
  already_refunded: { label: 'Already refunded', text: 'The matching charge has already been refunded in full. No additional refund was issued.' },
  partially_refunded: { label: 'Partially refunded', text: 'The matching charge has already been partially refunded. Our automatic full-refund process cannot handle this; contact the billing team for review.' },
  multiple_duplicates: { label: 'Multiple duplicate charges', text: 'We found more than one duplicate charge. The billing team must approve the complete batch before any refund is issued.' },
  batch_limit_exceeded: { label: 'Batch requires manual review', text: 'The possible duplicate total exceeds the automatic correction limit. The billing team must review it manually.' },
  incomplete_charge_history: { label: 'Charge history incomplete', text: 'More billing history must be checked before the complete correction can be proposed.' },
  not_duplicate: { label: 'No matching duplicate', text: 'The charges examined do not establish a matching duplicate. No refund was issued.' },
  insufficient_evidence: { label: 'Inconclusive', text: 'We could not establish a duplicate from the available records. No refund was issued. Contact the billing team if you need further review.' },
};
export const outcomeFor = (finding) => OUTCOMES[finding?.outcome] || OUTCOMES[finding?.verdict === 'duplicate' ? 'duplicate' : 'insufficient_evidence'];

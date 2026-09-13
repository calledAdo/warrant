import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceDuplicateRule } from '../src/duplicate-policy.js';
import { assembleCaseByRules } from '../src/agent-rules.js';
import { getCharge } from '../src/adapters/stripe.js';
import { buildBatchPlan, hashPlan } from '../src/plan.js';
const charge=(id,extra={})=>({id,amount:4900,currency:'usd',created:1000,status:'succeeded',description:'Pro',refunded:false,amount_refunded:0,...extra});
const proposed={verdict:'duplicate',charge_to_refund:'b',duplicate_of:'a',grounds:'Model reason',evidence:[{source:'github',id:'#invented',detail:'invented'}]};
test('both paths reject partially refunded candidates, including kept charge',()=>{
  for(const id of ['a','b']) {
    const charges=[charge('a'),charge('b',{created:1010})];charges.find(c=>c.id===id).amount_refunded=100;
    assert.equal(enforceDuplicateRule(proposed,charges,[]).finding.verdict,'insufficient_evidence');
    assert.equal(assembleCaseByRules({charges,incidents:[]}).verdict,'insufficient_evidence');
  }
});
test('fallback searches beyond a first uncorroborated amount pair',()=>{
  const charges=[charge('x',{description:'A'}),charge('y',{description:'B'}),charge('a',{amount:7900}),charge('b',{amount:7900,created:1010})];
  assert.equal(assembleCaseByRules({charges,incidents:[]}).charge_to_refund,'b');
});
test('no blank-description corroboration; evidence citations rebuilt from provider records',()=>{
  assert.equal(enforceDuplicateRule(proposed,[charge('a',{description:''}),charge('b',{description:''})],[]).overridden,true);
  const result=enforceDuplicateRule(proposed,[charge('a'),charge('b',{created:1010})],[]);
  assert.equal(result.overridden,false);assert.deepEqual(result.finding.evidence.map(e=>e.id),['b','a']);
});
test('model cannot label missing records already refunded',()=>{
  const result=enforceDuplicateRule({verdict:'insufficient_evidence',outcome:'already_refunded'},[],[]);
  assert.equal(result.finding.outcome,'insufficient_evidence');
});
test('runtime Stripe rejects live keys before requesting provider data',async()=>{
  process.env.STRIPE_SECRET_KEY='sk_live_not_a_real_key';await assert.rejects(getCharge('ch_none'),/test-mode key/);
});

test('three matching charges produce an actionable batch finding on model and rules paths',()=>{
  const charges=[charge('a',{created:1000}),charge('b',{created:1010}),charge('c',{created:1020})];
  const model=enforceDuplicateRule(proposed,charges,[]).finding;
  const rules=assembleCaseByRules({charges,incidents:[]});
  for(const finding of [model,rules]) {
    assert.equal(finding.verdict,'duplicate');
    assert.equal(finding.outcome,'multiple_duplicates');
    assert.equal(finding.legitimate_charge,'a');
    assert.deepEqual(finding.duplicate_charges,['b','c']);
    assert.equal(finding.excess_charge_count,2);
    assert.equal(finding.charge_to_refund,null);
  }
});

test('batch hash binds order, item amount and total',()=>{
  const fields={customer_id:'cus',kept_charge_id:'a',refunds:[
    {charge_id:'b',amount:4900,currency:'usd',duplicate_of:'a'},
    {charge_id:'c',amount:4900,currency:'usd',duplicate_of:'a'}]};
  const plan=buildBatchPlan(fields), original=hashPlan(plan);
  assert.notEqual(hashPlan({...plan,refunds:[...plan.refunds].reverse()}),original);
  assert.notEqual(hashPlan({...plan,refunds:plan.refunds.map((x,i)=>i?{...x,amount:5000}:x)}),original);
  assert.notEqual(hashPlan({...plan,total_amount:1}),original);
  assert.equal(plan.plan_id.length,68);
});

test('legacy short plan ids remain verifiable after the hash upgrade',()=>{
  const plan={customer_id:'cus',charge_id:'b',duplicate_of:'a',amount:4900,currency:'usd',action:'refund_full'};
  const full=hashPlan(plan);const legacy={...plan,plan_id:`wpl_${full.slice(4,20)}`};
  assert.equal(hashPlan(legacy),legacy.plan_id);
});

test('30-day grouping requires a strong shared key and an explicit incident coverage window',()=>{
  const start=1_700_000_000;
  const spread=['a','b','c'].map((id,i)=>charge(id,{created:start+i*10*86400,billing_keys:['invoice:inv_same']}));
  const incident={number:1,title:'Duplicate invoice charge retries',body:'Affected invoice: invoice:inv_same',billing_keys:['invoice:inv_same'],created_iso:new Date(start*1000).toISOString(),
    coverage_start_iso:new Date((start-1)*1000).toISOString(),coverage_end_iso:new Date((start+21*86400)*1000).toISOString()};
  assert.notEqual(enforceDuplicateRule(proposed,spread,[]).finding.outcome,'multiple_duplicates');
  assert.notEqual(enforceDuplicateRule(proposed,spread.map(x=>({...x,billing_keys:[]})),[incident]).finding.outcome,'multiple_duplicates');
  assert.equal(enforceDuplicateRule(proposed,spread,[incident]).finding.outcome,'multiple_duplicates');
  const recurring=spread.map((x,i)=>({...x,billing_keys:[`invoice:inv_${i}`]}));
  assert.notEqual(enforceDuplicateRule(proposed,recurring,[incident]).finding.outcome,'multiple_duplicates');
});

test('unrelated nearby incidents do not corroborate differing descriptions',()=>{
  const incident={number:2,title:'Search deployment',body:'Index latency',created_iso:new Date(1010*1000).toISOString()};
  const result=enforceDuplicateRule(proposed,[charge('a',{description:'A'}),charge('b',{created:1010,description:'B'})],[incident]);
  assert.equal(result.overridden,true);
});

test('oversized duplicate groups require manual review without a plan verdict',()=>{
  const charges=Array.from({length:12},(_,i)=>charge(String(i),{created:1000+i}));
  const finding=assembleCaseByRules({charges,incidents:[]});
  assert.equal(finding.verdict,'insufficient_evidence');assert.equal(finding.outcome,'batch_limit_exceeded');
});

test('model-selected ids anchor which qualifying batch is proposed',()=>{
  const charges=[charge('a'),charge('b',{created:1001}),charge('c',{created:1002}),
    charge('x',{amount:5900,created:2000}),charge('y',{amount:5900,created:2001}),charge('z',{amount:5900,created:2002})];
  const selected={...proposed,charge_to_refund:'z',duplicate_of:'x'};
  const finding=enforceDuplicateRule(selected,charges,[]).finding;
  assert.equal(finding.legitimate_charge,'x');assert.deepEqual(finding.duplicate_charges,['y','z']);
});

test('an inconclusive model finding is not upgraded to an unrelated batch',()=>{
  const charges=[charge('a'),charge('b',{created:1001}),charge('c',{created:1002})];
  const finding=enforceDuplicateRule({verdict:'insufficient_evidence',missing_evidence:'No matching reported purchase.'},charges,[]).finding;
  assert.notEqual(finding.outcome,'multiple_duplicates');
  assert.equal(assembleCaseByRules({charges,incidents:[]}).outcome,'multiple_duplicates');
});

test('three charges do not group without common corroboration or within one 24-hour window',()=>{
  const mixed=[charge('a',{description:'A'}),charge('b',{created:1010,description:'B'}),charge('c',{created:1020,description:'C'})];
  assert.notEqual(enforceDuplicateRule(proposed,mixed,[]).finding.outcome,'multiple_duplicates');
  const spread=[charge('a',{created:1000}),charge('b',{created:1000+20*3600}),charge('c',{created:1000+40*3600})];
  assert.notEqual(enforceDuplicateRule(proposed,spread,[]).finding.outcome,'multiple_duplicates');
});

test('a refunded third charge is excluded from a new multiple-duplicate group',()=>{
  const charges=[charge('a'),charge('b',{created:1010}),charge('c',{created:1020,refunded:true,amount_refunded:4900})];
  assert.notEqual(enforceDuplicateRule(proposed,charges,[]).finding.outcome,'multiple_duplicates');
});

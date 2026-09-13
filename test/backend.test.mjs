import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'warrant-backend-'));
process.env.WARRANT_DB=join(dir,'db.sqlite');
process.env.WARRANT_TEST_PROVIDER=join(dir,'provider.json');
process.env.LLM_MODE='rules'; process.env.OPENAI_API_KEY='offline';
process.env.LEMMA_API_KEY=''; process.env.LEMMA_PROJECT_ID='';
writeFileSync(process.env.WARRANT_TEST_PROVIDER,JSON.stringify({charges:[],calls:[]}));
const { installMocks, seed, calls, updateCharge, traceRecords, readProvider, writeProvider } = await import('./helpers.mjs');
installMocks();
const { createRun, investigate, approve, execute, replay, runs, recoverRuns, decline, resume, journalFor } = await import('../src/run.js');
const { db } = await import('../src/storage.js');
const { graph } = await import('../src/graph.js');
const { getOp, refundKey, withJournal, reconcileOperation } = await import('../src/journal.js');
const { customerView, create: createComplaint, attachRun } = await import('../src/complaints.js');
const { isExpired } = await import('../src/plan.js');
after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});

const investigation = async customer => { const r=createRun('Please check the duplicate.',customer); await investigate(r); return r; };
test('rules mode performs no model calls; initial writes journalled; refund and replay occur once', async()=>{
  seed('rules'); const run=await investigation('rules');
  assert.equal(run.status,'awaiting_approval'); assert.equal(calls('model').length,0);
  assert.deepEqual(journalFor(run.id).map(o=>o.step),['write_case','post_proposal']);
  approve(run,'reviewer@test'); await execute(run); assert.equal(run.status,'complete',run.error);
  const refunds=calls('refund').length, comments=calls('comment').length;
  await replay(run); assert.equal(run.status,'complete',run.error);
  assert.equal(calls('refund').length,refunds); assert.equal(calls('comment').length,comments);
  assert.equal(getOp(refundKey(run.plan)).status,'succeeded');
  assert.ok(traceRecords.some(s=>s.name==='approval-check'&&s.output.plan_hash_match));
});
test('partially refunded charge refuses with accurate backend outcome', async()=>{
  seed('partial',{amount_refunded:1000}); const r=await investigation('partial');
  assert.equal(r.status,'refused'); assert.equal(r.finding.outcome,'partially_refunded'); assert.equal(r.plan,null);
  assert.match(customerView({id:'test'},r).outcome.text,/partially refunded/);
  assert.match(calls('case').at(-1).title,/partially refunded/);
});
test('already refunded and inconclusive are distinct', async()=>{
  seed('refunded',{amount_refunded:4900,refunded:true}); const r=await investigation('refunded');
  assert.equal(r.finding.outcome,'already_refunded');
  const unknown=await investigation('nocharges'); assert.equal(unknown.finding.outcome,'insufficient_evidence');
  assert.match(customerView({},unknown).outcome.text,/could not establish/);
});
test('model path records complete messages and uses shared guard',async()=>{
  process.env.LLM_MODE='llm'; seed('model'); const r=await investigation('model');
  assert.equal(r.status,'awaiting_approval',r.error); assert.equal(r.finding.outcome,'duplicate');
  assert.ok(traceRecords.some(s=>s.name==='agent-turn-2'&&s.input.messages.some(m=>m.role==='tool')));
  process.env.LLM_MODE='rules';
});
test('outage fallback cannot approve partial refunds; fallback-off stops',async()=>{
  process.env.LLM_MODE='llm'; process.env.WARRANT_MODEL_FAIL='1'; seed('outage',{amount_refunded:500});
  const r=await investigation('outage'); assert.equal(r.finding.outcome,'partially_refunded');assert.equal(r.plan,null);
  process.env.LLM_FALLBACK='off'; const failed=await investigation('outage'); assert.equal(failed.status,'error');assert.equal(failed.caseNumber,null);
  delete process.env.WARRANT_MODEL_FAIL;delete process.env.LLM_FALLBACK;process.env.LLM_MODE='rules';
});
test('refund state changed after approval stops new money movement',async()=>{
  seed('changed'); const r=await investigation('changed'); approve(r);
  updateCharge(r.plan.charge_id,{amount_refunded:500}); const before=calls('refund').length;
  await execute(r);assert.equal(r.status,'error');assert.match(r.error,/partially refunded/);assert.equal(calls('refund').length,before);
});
test('same financial plan on separate cases has independent approvals and decline records',async()=>{
  seed('two');const a=await investigation('two'),b=await investigation('two');assert.equal(a.plan.plan_id,b.plan.plan_id);
  await decline(a,'a@test','review');await decline(b,'b@test','review');
  const records=calls('comment');assert.ok(records.some(x=>x.number===a.caseNumber));assert.ok(records.some(x=>x.number===b.caseNumber));
  assert.equal(journalFor(a.id).filter(x=>x.step==='decline_case').length,1);
  assert.equal(journalFor(b.id).filter(x=>x.step==='decline_case').length,1);
});
test('paused approval survives process restart; completed customer status also survives',async()=>{
  seed('restart');const r=await investigation('restart');
  const c=createComplaint({email:'restart@test',body:'check',customer:{id:'restart',name:'Restart'}});attachRun(c.id,r.id);
  const worker=execFileSync(process.execPath,['--experimental-test-module-mocks','test/restart-worker.mjs',r.id,'approve'],{env:process.env,encoding:'utf8'});
  assert.equal(JSON.parse(worker.trim()).status,'complete');
  const again=execFileSync(process.execPath,['--experimental-test-module-mocks','test/restart-worker.mjs',r.id,'inspect'],{env:process.env,encoding:'utf8'});
  const restored=JSON.parse(again.trim());assert.equal(restored.status,'complete');assert.equal(customerView(c,restored).stage_label,'Resolved');
});
test('journal keeps ambiguous writes uncertain; retry does not repeat the call',async()=>{
  let count=0;const options={planId:'audit',runId:'audit',step:'write_case'};
  await assert.rejects(withJournal('ambiguous',options,async()=>{count++;throw new Error('response lost');}));
  assert.equal(getOp('ambiguous').status,'uncertain');
  assert.equal((await withJournal('ambiguous',options,async()=>{count++;})).uncertain,true);assert.equal(count,1);
  reconcileOperation('ambiguous',{status:'succeeded',result:{number:99,url:'https://example.test/99'},note:'Read back case 99'});
  assert.equal((await withJournal('ambiguous',options,async()=>{count++;})).result.number,99);assert.equal(count,1);
});
test('expiry invalid dates fail closed, and approve rejects expired plans',async()=>{
  assert.equal(isExpired({expires_at:'invalid'}),true);seed('expired');const r=await investigation('expired');r.plan.expires_at='2000-01-01';assert.throws(()=>approve(r),/expired/);
});

test('GitHub follow-up failure survives restart without repeating refund or successful notification',async()=>{
  seed('followup');const r=await investigation('followup');approve(r);
  process.env.WARRANT_COMMENT_FAIL='1';await execute(r);delete process.env.WARRANT_COMMENT_FAIL;
  assert.equal(r.status,'notification_partial');const refunds=calls('refund').length, notifications=calls('applied').length;
  const output=execFileSync(process.execPath,['--experimental-test-module-mocks','test/restart-worker.mjs',r.id,'resume'],{env:process.env,encoding:'utf8'});
  assert.equal(JSON.parse(output.trim()).status,'complete');assert.equal(calls('refund').length,refunds);assert.equal(calls('applied').length,notifications);
});
test('human-tagged Lemma holds persist, require fresh reads, then resume to approval',async()=>{
  process.env.LEMMA_API_KEY='offline';process.env.LEMMA_PROJECT_ID='offline-project';
  let tagged=true, unavailable=false;
  globalThis.fetch=async()=>{
    if(unavailable) throw new Error('monitoring unavailable');
    return {ok:true,json:async()=>({issues:[{id:'issue-1',agent_name:'warrant.execute',status:'open',name:'Review this',tags:tagged?[{name:'warrant-hold'}]:[]}],has_more:false})};
  };
  seed('held');const r=await investigation('held');assert.equal(r.status,'held');assert.equal(r.plan,null);
  assert.equal(r.hold.reason,'warrant-hold');
  await resume(r);assert.equal(r.status,'held');
  unavailable=true;await resume(r);assert.equal(r.status,'held');assert.equal(r.hold.stale,true);
  unavailable=false;tagged=false;await resume(r);assert.equal(r.status,'awaiting_approval',r.error);assert.ok(r.plan);assert.equal(r.hold,null);
  // No active tags means no blocking even if Lemma still reports an issue.
  process.env.LEMMA_API_KEY='';process.env.LEMMA_PROJECT_ID='';
  globalThis.fetch=async()=>{throw new Error('network forbidden');};
});
test('restart restores a hold and never issues a proposal during startup',async()=>{
  process.env.LEMMA_API_KEY='offline';process.env.LEMMA_PROJECT_ID='held-project';
  globalThis.fetch=async()=>({ok:true,json:async()=>({issues:[{id:'issue-2',agent_name:'warrant.investigate',status:'in_progress',tags:[{name:'warrant-hold'}]}],has_more:false})});
  seed('heldrestart');const r=await investigation('heldrestart');assert.equal(r.status,'held');
  const before=calls('proposal').length;
  const output=execFileSync(process.execPath,['--experimental-test-module-mocks','test/restart-worker.mjs',r.id,'inspect'],{env:process.env,encoding:'utf8'});
  assert.equal(JSON.parse(output.trim()).status,'held');assert.equal(calls('proposal').length,before);
  process.env.LEMMA_API_KEY='';process.env.LEMMA_PROJECT_ID='';globalThis.fetch=async()=>{throw new Error('network forbidden');};
});

const addMatchingCharges = (customer, count) => {
  seed(customer);
  const provider=readProvider();
  const base=provider.charges.find(c=>c.customer===customer && c.id.endsWith('b'));
  for(let i=2;i<count;i++) provider.charges.push({...base,id:`ch_${customer}${String.fromCharCode(97+i)}`,created:base.created+(i-1)*10,
    created_iso:new Date((base.created+(i-1)*10)*1000).toISOString()});
  writeProvider(provider);
};

test('three matching debits create and execute one exact batch plan',async()=>{
  addMatchingCharges('multiple',3);
  const run=await investigation('multiple');
  assert.equal(run.status,'awaiting_approval');
  assert.equal(run.finding.outcome,'multiple_duplicates');
  assert.deepEqual(run.finding.duplicate_charges,['ch_multipleb','ch_multiplec']);
  assert.equal(run.plan.action,'refund_batch_full');
  assert.equal(run.plan.kept_charge_id,'ch_multiplea');
  assert.equal(run.plan.total_amount,9800);
  assert.deepEqual(run.plan.refunds.map(x=>x.charge_id),['ch_multipleb','ch_multiplec']);
  approve(run);await execute(run);
  assert.equal(run.status,'complete',run.error);
  assert.deepEqual(calls('refund').slice(-2).map(x=>x.key),['refund_full:ch_multipleb','refund_full:ch_multiplec']);
  assert.equal(readProvider().charges.find(x=>x.id==='ch_multiplea').amount_refunded,0);
  assert.match(calls('case').at(-1).title,/multiple duplicate charges/);
  assert.doesNotMatch(calls('case').at(-1).body,/refund of `null`/);
  assert.equal(customerView({},run).outcome.amount,9800);
});

test('four charges refund all three excess charges and replay issues no second refund',async()=>{
  addMatchingCharges('four',4);const run=await investigation('four');approve(run);await execute(run);
  assert.equal(run.status,'complete');assert.equal(run.plan.refunds.length,3);
  const count=calls('refund').length;await replay(run);assert.equal(calls('refund').length,count);
});

test('batch keeps early success and resume retries only a definitively failed item',async()=>{
  addMatchingCharges('batchfail',3);const run=await investigation('batchfail');approve(run);
  process.env.WARRANT_REFUND_FAIL='ch_batchfailc';await execute(run);delete process.env.WARRANT_REFUND_FAIL;
  assert.equal(run.status,'financial_partial');
  assert.equal(customerView({},run).stage_label,'Under Review');
  assert.match(customerView({},run).outcome.text,/1 of 2/);
  assert.equal(calls('refund').filter(x=>x.result?.charge==='ch_batchfailb').length,1);
  await resume(run);assert.equal(run.status,'complete',run.error);
  assert.equal(calls('refund').filter(x=>x.result?.charge==='ch_batchfailb').length,1);
  assert.equal(calls('refund').filter(x=>x.result?.charge==='ch_batchfailc').length,1);
});

test('a definitive first-item rejection produces failed aggregate state',async()=>{
  addMatchingCharges('batchallfailed',3);const run=await investigation('batchallfailed');approve(run);
  process.env.WARRANT_REFUND_FAIL='ch_batchallfailedb';await execute(run);delete process.env.WARRANT_REFUND_FAIL;
  assert.equal(run.status,'failed');
  assert.equal(calls('refund').filter(x=>x.result?.charge?.startsWith('ch_batchallfailed')).length,0);
});

test('restart during a partial batch completes only the remaining refund',async()=>{
  addMatchingCharges('batchrestart',3);const run=await investigation('batchrestart');approve(run);
  process.env.WARRANT_REFUND_FAIL='ch_batchrestartc';await execute(run);delete process.env.WARRANT_REFUND_FAIL;
  assert.equal(run.status,'financial_partial');const count=calls('refund').length;
  const output=execFileSync(process.execPath,['--experimental-test-module-mocks','test/restart-worker.mjs',run.id,'resume'],{env:process.env,encoding:'utf8'});
  assert.equal(JSON.parse(output.trim()).status,'complete');assert.equal(calls('refund').length,count+1);
  assert.equal(calls('refund').filter(x=>x.result?.charge==='ch_batchrestartb').length,1);
});

test('already-refunded batch item blocks the whole batch before new money movement',async()=>{
  addMatchingCharges('batchrefunded',3);const run=await investigation('batchrefunded');approve(run);
  updateCharge('ch_batchrefundedc',{amount_refunded:4900,refunded:true});const count=calls('refund').length;
  await execute(run);assert.equal(run.status,'error');assert.equal(calls('refund').length,count);
});

test('uncertain batch result stops automatic resume for reconciliation',async()=>{
  addMatchingCharges('batchunknown',3);const run=await investigation('batchunknown');approve(run);
  process.env.WARRANT_REFUND_UNCERTAIN='ch_batchunknownc';await execute(run);delete process.env.WARRANT_REFUND_UNCERTAIN;
  assert.equal(run.status,'uncertain');const count=calls('refund').length;await resume(run);assert.equal(calls('refund').length,count);
});

test('provider result mismatch is never journalled as a successful refund',async()=>{
  seed('mismatch');const run=await investigation('mismatch');approve(run);
  process.env.WARRANT_REFUND_MISMATCH=run.plan.charge_id;await execute(run);delete process.env.WARRANT_REFUND_MISMATCH;
  assert.equal(run.status,'uncertain');assert.equal(getOp(refundKey(run.plan)).status,'uncertain');
});

test('batch validates every item before any new refund',async()=>{
  addMatchingCharges('batchchanged',3);const run=await investigation('batchchanged');approve(run);
  updateCharge('ch_batchchangedc',{amount:5000});const count=calls('refund').length;await execute(run);
  assert.equal(run.status,'error');assert.equal(calls('refund').length,count);
});

test('expired financial partial can be reapproved and completes only remaining work',async()=>{
  addMatchingCharges('reapprove',3);const run=await investigation('reapprove');approve(run);
  process.env.WARRANT_REFUND_FAIL='ch_reapprovec';await execute(run);delete process.env.WARRANT_REFUND_FAIL;
  assert.equal(run.status,'financial_partial');
  const expired={...run.plan,expires_at:'2000-01-01'};
  db.prepare('UPDATE run_approvals SET plan=? WHERE run_id=?').run(JSON.stringify(expired),run.id);
  await resume(run);assert.equal(run.status,'financial_partial');assert.match(run.error,/approval_expired/);
  approve(run,'second-reviewer@test');await execute(run);assert.equal(run.status,'complete',run.error);
  assert.equal(calls('refund').filter(x=>x.result?.charge==='ch_reapproveb').length,1);
});

test('model path refuses a batch while older charge pages remain',async()=>{
  process.env.LLM_MODE='llm';addMatchingCharges('incomplete',11);
  const run=await investigation('incomplete');process.env.LLM_MODE='rules';
  assert.equal(run.status,'refused');assert.equal(run.finding.outcome,'incomplete_charge_history');assert.equal(run.plan,null);
});
test('resume directly at refund rechecks expiry and refund state',async()=>{
  seed('direct');const r=await investigation('direct');approve(r);
  const cfg={configurable:{thread_id:r.id}};
  // Fork a real checkpoint at the executor boundary, as a crash/resume can do.
  await graph.updateState(cfg,{decision:{decision:'approve',approver:r.approver,plan_id:r.plan.plan_id}},'human_review');
  await graph.updateState(cfg,{},'verify_charge');
  updateCharge(r.plan.charge_id,{amount_refunded:200});const before=calls('refund').length;
  await resume(r);assert.equal(r.status,'error');assert.match(r.error,/partially refunded/);assert.equal(calls('refund').length,before);
});

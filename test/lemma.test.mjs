import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'warrant-lemma-'));
process.env.WARRANT_DB=join(dir,'db.sqlite');process.env.LEMMA_API_KEY='offline';process.env.LEMMA_PROJECT_ID='project';
mock.module('@uselemma/tracing',{namedExports:{Lemma:class {}}});
const { db }=await import('../src/storage.js');
const { listIssues, proposalHold, issuesForRun }=await import('../src/lemma-issues.js');
const { dashboardUrlFor,currentRelease }=await import('../src/trace.js');
after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
const respond = value => ({ok:true,json:async()=>value});

test('paginates all issues, ignores other agents, includes active tagged issues below the cutoff',async()=>{
  const offsets=[];
  globalThis.fetch=async input=>{
    const url=new URL(input);assert.equal(url.searchParams.get('expanded'),'true');const offset=Number(url.searchParams.get('offset'));offsets.push(offset);
    return respond(offset===0?{issues:[{id:'unrelated',status:'open',agent_name:'another.agent',tags:[{name:'warrant-hold'}]}],has_more:true}
      :{issues:[{id:'hold',status:'in_progress',agent_name:'warrant.execute',tags:[{name:'warrant-hold'}]}],has_more:false});
  };
  const result=await listIssues({force:true});assert.deepEqual(offsets,[0,100]);assert.deepEqual(result.issues.map(i=>i.id),['hold']);assert.equal(result.stale,false);
});
test('failed refresh preserves prior holds and reports stale data',async()=>{
  globalThis.fetch=async()=>{throw new Error('unavailable');};
  const hold=await proposalHold();assert.equal(hold.reason,'warrant-hold');assert.equal(hold.stale,true);
});
test('trace lookup paginates and caches older IDs; occurrences only attach matching issues',async()=>{
  let pages=0;
  globalThis.fetch=async input=>{
    const u=new URL(input);
    if(u.pathname==='/issues') return respond({issues:[{id:'attached',status:'open',agent_name:'warrant.investigate',tags:[]},{id:'other',status:'open',tags:[]}],has_more:false});
    if(u.pathname==='/traces/dashboard') {
      pages++;return respond(u.searchParams.has('cursor')?{data:[{id:'internal-old',otel_trace_id:'old'}],next_cursor:null}
        :{data:[{id:'internal-new',otel_trace_id:'new'}],next_cursor:{timestamp:'2026-09-13',id:'internal-new'}});
    }
    assert.equal(u.pathname,'/traces/internal-old/issue_occurrences');
    return respond({issue_occurrences:[{id:'occ',issue_id:'attached',issue:{id:'attached',status:'open'},title:'Finding'}]});
  };
  assert.equal((await dashboardUrlFor('old')).internalId,'internal-old');assert.equal(pages,2);
  assert.equal((await dashboardUrlFor('old')).internalId,'internal-old');assert.equal(pages,2);
  await listIssues({force:true});const result=await issuesForRun({id:'run',traceId:'old',traceIds:['old']});
  assert.equal(result.flagged,true);assert.deepEqual(result.issues.map(i=>i.id),['attached']);assert.equal(result.traces.length,1);
  assert.equal(currentRelease.endsWith('-dirty'),Boolean(execSync('git status --porcelain').toString().trim()));
});
test('untagged and resolved issues cannot hold a new proposal',async()=>{
  globalThis.fetch=async()=>respond({issues:[{id:'resolved',status:'resolved',tags:[{name:'warrant-hold'}]},{id:'open',status:'open',tags:[]}],has_more:false});
  assert.equal(await proposalHold(),null);
});

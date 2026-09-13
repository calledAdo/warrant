import { mock } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';

export const readProvider = () => JSON.parse(readFileSync(process.env.WARRANT_TEST_PROVIDER, 'utf8'));
export const writeProvider = state => writeFileSync(process.env.WARRANT_TEST_PROVIDER, JSON.stringify(state));
export function seed(customer, overrides = {}) {
  const data = readProvider();
  const t = Math.floor(Date.now()/1000)-100;
  data.charges.push(...['a','b'].map((x,i) => ({ id: `ch_${customer}${x}`, customer, amount: 4900, currency: 'usd', status: 'succeeded',
    created: t+i*10, created_iso: new Date((t+i*10)*1000).toISOString(), description: 'Invoice Pro', refunded: false, amount_refunded: 0,
    ...(i ? overrides : {}) })));
  writeProvider(data);
}
export const updateCharge = (id, fields) => { const d=readProvider(); Object.assign(d.charges.find(c=>c.id===id),fields); writeProvider(d); };
export function record(kind, value) { const d=readProvider(); d.calls.push({kind,...value}); writeProvider(d); }
export const calls = kind => readProvider().calls.filter(c => c.kind === kind);
export const traceRecords = [];
let modelTurn = 0;

export function installMocks() {
  globalThis.fetch = async () => { throw new Error('Network is forbidden in offline backend tests'); };
  mock.module('../src/adapters/stripe.js', { namedExports: {
    getCustomer: async id => ({ id, name: id, email: `${id}@test.invalid` }),
    findCustomerByEmail: async email => ({id: email.split('@')[0], name: email, email}),
    searchCharges: async (id,args={}) => {
      record('search', { customer: id });
      const charges=readProvider().charges.filter(c=>c.customer===id).sort((a,b)=>b.created-a.created);
      const start=args.cursor ? charges.findIndex(c=>c.id===args.cursor)+1 : 0;
      const page=charges.slice(start,start+10), more=start+10<charges.length;
      return {charges:page, has_more:more, next_cursor:more?page.at(-1).id:null,window:{from:'2026-01-01',to:'now'}};
    },
    listCharges: async id => readProvider().charges.filter(c=>c.customer===id),
    getCharge: async id => { record('get_charge',{id}); return readProvider().charges.find(c=>c.id===id); },
    refundFull: async (id,amount,key) => {
      const d=readProvider();
      const previous=d.calls.find(c=>c.kind==='refund'&&c.key===key);
      if(previous) return previous.result;
      if(process.env.WARRANT_REFUND_FAIL===id) { const e=new Error(`refund rejected for ${id}`);e.definitiveRejection=true;throw e; }
      if(process.env.WARRANT_REFUND_UNCERTAIN===id) throw new Error(`refund response lost for ${id}`);
      const c=d.charges.find(c=>c.id===id);
      const result={id:`re_${d.calls.length}`,amount:process.env.WARRANT_REFUND_MISMATCH===id?amount-1:amount,charge:id,status:'succeeded'};
      c.amount_refunded=c.amount; c.refunded=true;
      d.calls.push({kind:'refund',key,result}); writeProvider(d); return result;
    },
  }});
  mock.module('../src/adapters/github.js', { namedExports: {
    searchIncidents: async () => ({incidents:[],window:{from:'2026-01-01',to:'now'}}),
    findIncidents: async () => [],
    createCase: async ({title,body}) => { const result={number:calls('case').length+1,url:'https://example.test/case'}; record('case',{title,body,result}); return result; },
    comment: async (number,body) => { if (process.env.WARRANT_COMMENT_FAIL==='1') { const e=new Error('GitHub rejected request');e.definitiveRejection=true;throw e; } record('comment',{number,body}); return {id:calls('comment').length}; },
  }});
  mock.module('../src/adapters/slack.js', { namedExports: {
    postProposal: async plan => { record('proposal',{plan}); return {channel:'test',ts:`${calls('proposal').length}`}; },
    postRefusal: async (...args) => { record('refusal',{args}); return {channel:'test',ts:'refusal'}; },
    updateApplied: async (channel,ts,plan) => { record('applied',{channel,ts,plan}); return {ts}; },
    updateDeclined: async (channel,ts,plan) => { record('declined',{channel,ts,plan}); return {ts}; },
  }});
  mock.module('../src/trace.js', { namedExports: {
    lemma: { trace: async (options,fn) => {
      traceRecords.push(options);
      return fn({ id: `trace_${Date.now()}`, recordSpan: x=>traceRecords.push(x), recordGeneration: x=>traceRecords.push(x),
        startTool: options => ({end: result=>traceRecords.push({...options,...result})}) });
    } },
    dashboardUrlFor: async id => ({internalId:id,url:`https://example.test/${id}`}),
    tracingEnabled: false, currentRelease: 'test',
  }});
  mock.module('../src/llm.js', { namedExports: {
    chatWithTools: async ({messages}) => {
      record('model',{}); modelTurn++;
      if(process.env.WARRANT_MODEL_FAIL==='1') throw new Error('model unavailable');
      const last=messages.at(-1);
      const result = last.role === 'tool' ? JSON.parse(last.content) : null;
      const name=result ? 'submit_finding' : 'search_charges';
      const args=result ? {verdict:'duplicate',charge_to_refund:result.charges[0].id,duplicate_of:result.charges[1].id,grounds:'Model selected this pair.',evidence:[],uncertainty:'none'} : {};
      return {model:'test-model',message:{role:'assistant',content:'',tool_calls:[{id:`tool_${modelTurn}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]},durationMs:1,usage:{inputTokens:10,outputTokens:10}};
    },
    completeJSON: async () => {throw new Error('legacy model path not expected');},
    parseJSONObject: JSON.parse,
  }});
}

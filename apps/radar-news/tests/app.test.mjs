import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppHandler, hostContext } from 'apps/host';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import app from '../.build/index.js';
import { EXA_SEARCH, EXA_CONTENTS, JEV_MODELS, JEV_INFER } from '../.build/src/exa.js';

async function host(t) {
  const db = new DatabaseSync(':memory:'); t.after(()=>db.close());
  const handle = createAppHandler(app);
  const storage = {sql:{exec(sql,...bindings){
    const empty = {columnNames:[],rowsRead:0,rowsWritten:0,toArray:()=>[]};
    if (sql.trim().includes(';') && !bindings.length) {db.exec(sql);return empty;}
    const statement = db.prepare(sql); const columns = statement.columns().map(x=>x.name);
    if (columns.length) {const rows = statement.all(...bindings).map(x=>({...x})); return {columnNames:columns,rowsRead:rows.length,rowsWritten:0,toArray:()=>rows};}
    return {...empty,rowsWritten:Number(statement.run(...bindings).changes)};
  }},transactionSync(work){db.exec('SAVEPOINT sandbox');try{const r=work();db.exec('RELEASE sandbox');return r;}catch(e){db.exec('ROLLBACK TO sandbox; RELEASE sandbox');throw e;}}};
  const path = 'migrations/0001_runs.sql';
  const files = [{path,content:readFileSync(new URL('../'+path,import.meta.url),'utf8')}];
  const empty = {exa:[],jev:[]};
  const request = async (payload, accounts=empty) => {
    const response = await handle(new Request('https://executor.local/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),{...hostContext({app:accounts,user:{}}),storage,files});
    return {status:response.status,body:await response.json()};
  };
  const success = async (...args) => {
    const r=await request(...args);
    assert.equal(r.status,200, 'SDK returned '+r.status+' '+(r.body?.error?._tag??''));
    return r.body.value;
  };
  const r=await request({operation:'requirements'}); assert.equal(r.status,200);
  const req=r.body.requirements??r.body.value??r.body;
  assert.equal(req.sql,true);
  assert.deepEqual(Object.keys(req.accounts.app).sort(),['exa','jev']); assert.deepEqual(req.accounts.user,{});
  assert.equal(req.accounts.app.exa.cardinality,'many'); assert.equal(req.accounts.app.jev.cardinality,'many');
  assert.deepEqual(req.accounts.app.exa.definition.hosts,['api.exa.ai']);
  assert.deepEqual(req.accounts.app.jev.definition.hosts,['api.typesafe.ai']);
  const account=(slot,n=1)=>({id:'acc_fixture_'+slot+n,provider:req.accounts.app[slot].definition,method:'apiKey',fields:{key:'offline-fixture-only'}});
  const accounts = {exa:[account('exa')],jev:[]};
  await success({operation:'migrate'});
  return {db,request,success, account, accounts,
    collect:(a=accounts)=>success({operation:'call',tool:'collect',kind:'mutation',input:{}},a),
    latest:(input={})=>success({operation:'call',tool:'latest',kind:'query',input},empty)};
}
const monday=new Date('2026-11-23T11:45:00-03:00');
const clock = t => t.mock.timers.enable({apis:['Date'],now:monday});
const url=i=>'https://news.example/post?id='+i;
const hit=(i)=>({url:url(i),title:'Notícia sintética '+i,publishedDate:'2026-11-23T10:00:00-03:00'});
const current='2026-11-23';

// Simulação offline: SDK real + SQLite descartável; nenhum provider real.
test('native handler migrates and pages a usable lot, then shows next-day total failure without stale items', async t=>{
  clock(t); const h=await host(t);
  const first=await h.latest(); assert.equal(first.status,'not_run'); assert.equal(first.lot,null);
  let mode='good', calls=0;
  t.mock.method(globalThis,'fetch',async (u,init)=>{
    const target=String(u);
    calls++; assert.equal(init.redirect,'manual'); assert.equal(new Headers(init.headers).has('x-api-key'),true);
    if (mode==='bad') return new Response(null,{status:503});
    if(target===EXA_SEARCH) return Response.json({results:(await new Response(init.body).json()).query.includes('inteligência artificial')?[hit(1),hit(2),hit(3)]:[]});
    assert.equal(target,EXA_CONTENTS);
    return Response.json({results:[1,2,3].map(i=>({...hit(i),text:'Trecho sintético '+i})),statuses:[1,2,3].map(i=>({id:url(i),status:'success'}))});
  });
  const saved=await h.collect(); assert.equal(saved.status,'ok'); assert.equal(calls,4);
  const p1=await h.latest({limit:2,date_brt:current}); assert.equal(p1.status,'ok'); assert.equal(p1.ready,true);
  assert.equal(p1.lot.captured_at,'2026-11-23T14:45:00.000Z');
  assert.deepEqual(p1.lot.window,{start:'2026-11-20T14:45:00.000Z',end:'2026-11-23T14:45:00.000Z'});
  assert.equal(p1.lot.jev.error,'missing_account');
  assert.equal(p1.lot.counts.total,3); assert.equal(p1.returned,2); assert.equal(p1.next_offset,2);
  const p2=await h.latest({offset:p1.next_offset,limit:2,run_id:p1.lot.run_id,date_brt:current});
  assert.equal(p2.next_offset,null); assert.equal(p2.returned,1);
  assert.equal(p2.items[0].source_url,url(3));
  assert.equal((await h.latest({run_id:'wrong'})).status,'run_mismatch');
  assert.equal((await h.latest({date_brt:'2026-02-30'})).status,'invalid_input');
  assert.equal((await h.latest({offset:1.2})).status,'invalid_input');
  mode='bad'; t.mock.timers.setTime(+new Date('2026-11-24T11:45:00-03:00'));
  const failed=await h.collect(); assert.equal(failed.status,'failed'); assert.equal(calls,7);
  const today=await h.latest(); assert.equal(today.status,'failed'); assert.equal(today.ready,false);
  assert.equal(today.items.length,0); assert.equal(today.lot.searches.ia.status,'http_503');
  assert.equal(today.previous_usable.run_id,p1.lot.run_id);
  assert.notEqual(today.previous_usable.date_brt,today.date_brt);
  assert.equal((await h.latest({date_brt:current})).lot.run_id,p1.lot.run_id);
});

test('missing or multiple Exa accounts use no network and do not reserve the paid run',async t=>{
  clock(t); const h=await host(t); let calls=0;
  t.mock.method(globalThis,'fetch',async ()=>{calls++;return Response.json({results:[]});});
  assert.equal((await h.collect({exa:[],jev:[]})).reason,'missing_account');
  assert.equal((await h.collect({exa:[h.account('exa'),h.account('exa',2)],jev:[]})).reason,'multiple_accounts');
  assert.equal(calls,0); assert.equal((await h.latest()).status,'failed');
  assert.equal((await h.collect()).status,'no_news'); assert.equal(calls,3);
  assert.equal((await h.latest()).ready,true);
});

test('atomic day reservation prevents concurrent and crash-uncertain resubmission',async t=>{
  clock(t); const h=await host(t); let calls=0, release, observed;
  const started = new Promise(resolve=>{observed=resolve;});
  const gate = new Promise(resolve=>{release=resolve;});
  t.mock.method(globalThis,'fetch',async ()=>{calls++;observed();await gate;throw new TypeError('offline simulated lost response');});
  const pending=h.collect();
  try {
    await started;
    assert.equal((await h.collect()).status,'running'); assert.equal(calls,3);
    t.mock.timers.setTime(+monday+60_000);
    const stuck=await h.latest(); assert.equal(stuck.status,'uncertain_no_retry'); assert.equal(stuck.ready,false);
    assert.equal((await h.collect()).status,'uncertain_no_retry'); assert.equal(calls,3);
  } finally {release(); await pending;}
  assert.equal((await h.collect()).status,'failed'); assert.equal(calls,3);
});

test('SDK checks scoped providers without paid endpoints and classifies rejection safely',async t=>{
  clock(t); const h=await host(t); const calls=[];let invalid=false, malformed=false;
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    const target=String(url), headers=new Headers(init.headers); calls.push(target);
    assert.equal(init.method,'GET'); assert.equal(init.redirect,'manual');
    if(invalid) return new Response(null,{status:401});
    if(target==='https://api.exa.ai/v0/teams/me') return Response.json({tag:'NOT_FOUND'},{status:404});
    if(target==='https://api.exa.ai/monitors?limit=1'){assert.equal(headers.has('x-api-key'),true);assert.equal(headers.has('authorization'),false);return Response.json(malformed ? {} : {data:[],hasMore:false,nextCursor:null});}
    assert.equal(target,JEV_MODELS); assert.equal(headers.has('authorization'),true);assert.equal(headers.has('x-api-key'),false);
    return Response.json({models:[{name:'jev-latest'}]});
  });
  for(const slot of ['exa','jev']){
    invalid=false;const input={operation:'account-check',requirement:slot}; const binding={[slot]:h.account(slot)};
    const ok=await h.request(input,binding); assert.equal(ok.status,200);
    invalid=true; const bad=await h.request(input,binding);
    assert.equal(JSON.stringify(bad.body).includes('unauthorized'),true);
  }
  invalid=false; malformed=true;
  const odd=await h.request({operation:'account-check',requirement:'exa'},{exa:h.account('exa')});
  assert.equal(odd.status,502); assert.equal(JSON.stringify(odd.body).includes('unavailable'),true);
  assert.deepEqual(calls,['https://api.exa.ai/monitors?limit=1','https://api.exa.ai/monitors?limit=1',JEV_MODELS,JEV_MODELS,'https://api.exa.ai/monitors?limit=1']);
});

test('multiple Jev accounts or an unauthorized Jev POST never block the core lot',async t=>{
  clock(t); const h=await host(t);let paid=0;
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    const target=String(url);
    if(target===JEV_INFER){paid++;return new Response(null,{status:403});}
    if(target===EXA_SEARCH) return Response.json({results:(await new Response(init.body).json()).query.includes('inteligência artificial')?[hit(1),hit(2)]:[]});
    assert.equal(target,EXA_CONTENTS); return Response.json({results:[1,2].map(i=>({...hit(i),text:'Trecho'}))});
  });
  assert.equal((await h.collect({...h.accounts,jev:[h.account('jev'),h.account('jev',2)]})).status,'ok');
  assert.equal((await h.latest()).lot.jev.error,'multiple_accounts'); assert.equal(paid,0);
  t.mock.timers.setTime(+new Date('2026-11-24T09:00:00-03:00'));
  assert.equal((await h.collect({...h.accounts,jev:[h.account('jev')]})).status,'ok');
  const got=await h.latest(); assert.equal(got.lot.jev.error,'unauthorized'); assert.equal(got.items.length,2); assert.equal(paid,1);
  await h.collect({...h.accounts,jev:[h.account('jev')]}); assert.equal(paid,1);
});

test('SDK inspection declares exactly one app cron and one read-only query',async t=>{
  clock(t); const h=await host(t);
  const all=await h.success({operation:'inspect'});
  assert.deepEqual(all.tools.map(x=>[x.name,x.readOnly]).sort(),[['collect',false],['latest',true]]);
  const scheduled=await h.success({operation:'inspect',scheduled:true});
  assert.deepEqual(scheduled.tools.map(x=>[x.name,x.schedules]),[['collect',[{
    name:'pre_coleta',scope:'app',timing:{kind:'cron',calendar:{expression:'0 12 * * MON-FRI',timezone:'America/Sao_Paulo'}},input:{}
  }]]]);
});

test('SDK persists a Jev match and later preserves the lot when a paid response is lost',async t=>{
  clock(t);const h=await host(t); const accounts={...h.accounts,jev:[h.account('jev')]};
  let paid=0, lost=false;
  t.mock.method(globalThis,'fetch',async (input,init)=>{
    const target=String(input); const headers=new Headers(init.headers);
    if(target===JEV_INFER){
      paid++;assert.equal(headers.has('authorization'),true);assert.equal(headers.has('x-api-key'),false);
      if(lost) throw new TypeError('offline simulated lost response');
      return Response.json({model:'jev-test-version',answers:{q1:{type:'choice',choice:'c0',confidence:.95,probabilities:{c0:.99,none:.01}}}});
    }
    if(target===EXA_SEARCH) return Response.json({results:(await new Response(init.body).json()).query.includes('inteligência artificial')?[hit(1),hit(2)]:[]});
    assert.equal(target,EXA_CONTENTS);return Response.json({results:[1,2].map(i=>({...hit(i),text:'Trecho'}))});
  });
  assert.equal((await h.collect(accounts)).status,'ok');
  const first=await h.latest(); assert.equal(first.lot.jev.annotated,1);
  assert.deepEqual(first.items[1].jev,{duplicate_of:url(1),confidence:.95});
  lost=true;t.mock.timers.setTime(+new Date('2026-11-24T09:00:00-03:00'));
  const lostRun=await h.collect(accounts);assert.equal(lostRun.status,'ok');
  const next=await h.latest();assert.equal(next.lot.jev.error,'network');assert.equal(next.items.length,2);
  const retried=await h.collect(accounts); assert.equal(retried.reused,true); assert.equal(retried.run_id,lostRun.run_id); assert.equal(paid,2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { annotate, checkJev, JEV_MODEL } from '../.build/src/jev.js';
import { JEV_INFER, JEV_MODELS } from '../.build/src/exa.js';

// Fixtures sintéticas baseadas no envelope HTTP documentado da TypeSafe (Choice, Models).
const item = i => ({source_url:'https://news.example/story?edition='+i,canonical_url:'https://news.example/'+i,title:'Notícia sintética '+i,excerpt:'a'.repeat(719),sections:['ia']});
const env = fetch => ({fetch,signal:new AbortController().signal,account:{headers:()=>({Authorization:'Bearer fixture-only'})}});
const choice=(choice,confidence=.94)=>({type:'choice',choice,confidence,probabilities:{[choice]:.96,none:.04}});

test('Jev makes one bounded shadow call with excerpts and annotates original links only', async () => {
  const items=Array.from({length:12},(_,i)=>item(i)); let calls=0;
  const info = await annotate(env(async (url,init) => {
    calls++; assert.equal(url,JEV_INFER); assert.equal(init.redirect,'manual');
    const body=JSON.parse(init.body); assert.equal(body.model,JEV_MODEL);
    assert.equal(Object.keys(body.questions).length,11);
    assert.equal(Object.keys(body.questions.q1.criteria).length,2);
    assert.ok(!init.body.includes('https://news.example/'));
    assert.ok(!init.body.includes('a'.repeat(161)));
    return Response.json({model:'jev-test-version',answers:{q1:choice('c0'),q2:choice('c1',.35),...Object.fromEntries(Object.keys(body.questions).slice(2).map(k=>[k,{type:'choice',choice:'none',probabilities:{none:1},confidence:1}]))}});
  }),items);
  assert.equal(calls,1); assert.equal(info.status,'ok'); assert.equal(info.model_requested,JEV_MODEL);
  assert.equal(info.model_reported,'jev-test-version'); assert.equal(info.annotated,1);
  assert.deepEqual(items[1].jev,{duplicate_of:items[0].source_url,confidence:.94});
  assert.equal(items[2].jev,undefined); assert.equal(items.length,12);
});

test('Jev considers candidates in all three sections in one request', async () => {
  const items=['ia','auto','apple'].flatMap((section,j)=>Array.from({length:4},(_,i)=>({...item(4*j+i),sections:[section]})));
  let calls=0, q=[];
  const info=await annotate(env(async (_url,init)=>{
    calls++;
    q=Object.keys(JSON.parse(init.body).questions);
    return Response.json({answers:Object.fromEntries(q.map(k=>[k,choice('c'+(Number(k.slice(1))-1))]))});
  }),items);
  assert.deepEqual(q,['q1','q2','q3','q5','q6','q7','q9','q10','q11']);
  assert.equal(calls,1); assert.equal(info.status,'ok'); assert.equal(info.annotated,9); assert.equal(items.length,12);
  assert.equal(items[9].jev.duplicate_of,items[8].source_url);
});

test('Jev rejects out-of-shortlist options and keeps all items', async () => {
  const items=[item(0),item(1)];
  const info = await annotate(env(async () => Response.json({answers:{q1:choice('c11')}})),items);
  assert.equal(info.status,'failed'); assert.equal(info.error,'invalid_response'); assert.equal(info.annotated,0);
  assert.ok(items.every(x=>x.jev===undefined));
});

test('Jev negative authentication leaves items intact without retries or raw diagnostic bodies', async () => {
  let calls=0; const items=[item(0),item(1)];
  const info = await annotate(env(async () => {calls++;return new Response('discarded',{status:401})}),items);
  assert.equal(info.status,'failed'); assert.equal(info.error,'unauthorized'); assert.equal(calls,1);
  assert.ok(items.every(x=>x.jev===undefined));
});

test('Jev health consumes documented models envelope, never invokes inference', async () => {
  async function check(value,status=200) {
    return checkJev(env(async (url,init)=>{
      assert.equal(url,JEV_MODELS); assert.equal(init.method,'GET'); assert.equal(init.redirect,'manual');
      return Response.json(value,{status});
    }));
  }
  assert.equal(await check({models:[{name:JEV_MODEL}]}),null);
  assert.equal(await check({models:[{name:'other'}]}),'model_unavailable');
  assert.equal(await check([{name:JEV_MODEL}]),'invalid_response');
  assert.equal(await check({},401),'unauthorized');
});

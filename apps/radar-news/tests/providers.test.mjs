import test from 'node:test';
import assert from 'node:assert/strict';
import { windowFor } from '../.build/src/core.js';
import { collectExa, requestJson, EXA_SEARCH, EXA_CONTENTS, EXA_HEALTH } from '../.build/src/exa.js';

// Fixtures sintéticas derivadas de https://api.exa.ai/openapi.json, sem dados coletados.
const win = windowFor(new Date('2026-11-23T11:45:00-03:00'));
const hit = (url, date = '2026-11-23T09:00:00-03:00') => ({title:'Manchete sintética',url,publishedDate:date});
const first = 'https://news.example/noticia?id=11';
const unknown = 'https://apple.example/unknown';
const env = (fetch, signal = new AbortController().signal) => ({fetch, signal, account:{headers:()=>({'x-api-key':'fixture-only'})}});
const json = value => Response.json(value);

test('Exa extracts a bounded exact-deduped lot with multisection provenance and undated bucket', async () => {
  const requests = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body); requests.push({url,body});
    assert.equal(init.method,'POST'); assert.equal(init.redirect,'manual');
    if (url === EXA_CONTENTS) return json({results:[{...hit(first),text:'Trecho original',summary:'not a source excerpt'},{...hit(unknown,null),highlights:['Outro trecho original']}],statuses:[{id:first,status:'success'},{id:unknown,status:'success'}]});
    assert.equal(url,EXA_SEARCH);
    assert.equal(body.startPublishedDate,win.start); assert.equal(body.endPublishedDate,win.end);
    assert.equal(body.numResults,4); assert.equal(body.includeDomains,undefined);
    if (body.query.includes('inteligência artificial')) return json({results:[hit(first+'&utm_source=x'),hit('https://news.example/future','2026-11-23T11:45:01-03:00')]});
    if (body.query.includes('automotivo')) return json({results:[hit(first+'#original')]});
    return json({results:[hit(unknown,null)]});
  };
  const lot = await collectExa(env(fetch),win);
  assert.equal(requests.length,4);
  const body = requests.at(-1).body;
  assert.deepEqual(body.urls,[first,unknown]); assert.equal(body.summary,undefined);
  assert.equal(lot.status,'ok'); assert.equal(lot.items.length,1); assert.equal(lot.undated.length,1);
  assert.equal(lot.items[0].canonical_url,first); assert.equal(lot.items[0].source_url,first+'&utm_source=x');
  assert.deepEqual(lot.items[0].sections,['ia','auto']); assert.equal(lot.items[0].provenance.length,2);
  assert.equal(lot.items[0].excerpt,'Trecho original'); assert.equal(lot.undated[0].excerpt,'Outro trecho original');
  assert.equal(lot.counts.out_of_window,1); assert.equal(lot.counts.exact_duplicate_hits,1);
});

test('partial search/extraction errors are visible and do not remove candidates', async () => {
  const lot = await collectExa(env(async (url,init) => {
    if (url===EXA_CONTENTS) return json({results:[],statuses:[{id:first,status:'error',error:{tag:'CRAWL_NOT_FOUND',httpStatusCode:404}}]});
    return JSON.parse(init.body).query.includes('inteligência artificial') ? json({results:[hit(first)]}) : new Response(null,{status:429});
  }),win);
  assert.equal(lot.status,'partial'); assert.equal(lot.items.length,1);
  assert.equal(lot.items[0].extraction,'provider_error'); assert.equal(lot.items[0].excerpt,null);
  assert.equal(lot.searches.auto.status,'rate_limited'); assert.equal(lot.contents.failed,1);
});

test('a valid empty search is not a malformed search and neither extracts', async () => {
  for (const [value,status] of [[{results:[]},'no_news'],[{synthesis:'ignored'},'failed']]) {
    const calls=[]; const lot=await collectExa(env(async url=>{calls.push(url);return json(value);}),win);
    assert.equal(lot.status,status); assert.equal(lot.contents.status,'not_needed');
    assert.deepEqual(calls,[EXA_SEARCH,EXA_SEARCH,EXA_SEARCH]);
  }
});

test('Exa never accepts more than four results per search or contents beyond the shortlist', async () => {
  let urls;
  const lot = await collectExa(env(async (url,init) => {
    const body=JSON.parse(init.body);
    if (url===EXA_CONTENTS) {urls=body.urls; return json({results:[{...hit('https://other.example/not-requested'),text:'unrelated'}]});}
    const x=body.query.includes('inteligência artificial')?'ia':body.query.includes('automotivo')?'auto':'apple';
    return json({results:Array.from({length:8},(_,i)=>hit('https://news.example/'+x+'/'+i))});
  }),win);
  assert.equal(urls.length,12); assert.equal(lot.items.length,12); assert.equal(lot.status,'partial');
  assert.ok(lot.items.every(item=>item.excerpt===null));
});

test('HTTP helper rejects redirect, oversized stream and pre-aborted requests without echoing bodies', async () => {
  assert.deepEqual(await requestJson(env(async ()=>new Response('discarded',{status:302})),EXA_HEALTH,undefined,32,100),{ok:false,error:'redirect'});
  const oversized = new ReadableStream({start(c){c.enqueue(new Uint8Array(33));c.close();}});
  assert.deepEqual(await requestJson(env(async ()=>new Response(oversized)),EXA_HEALTH,undefined,32,100),{ok:false,error:'response_too_large'});
  const c=new AbortController(); c.abort(); let called=false;
  assert.deepEqual(await requestJson(env(async ()=>{called=true;return json({})},c.signal),EXA_HEALTH,undefined,32,100),{ok:false,error:'timeout'});
  assert.equal(called,false);
});

test('HTTP timeout also bounds waiting for response body and cancels it', async () => {
  let cancelled = false;
  const body = new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
  const keepAlive = setTimeout(()=>{},1000);
  try {
    assert.deepEqual(await requestJson(env(async ()=>new Response(body)),EXA_HEALTH,undefined,32,10),{ok:false,error:'timeout'});
    assert.equal(cancelled,true);
  } finally { clearTimeout(keepAlive); }
});

test('Exa midnight sentinel stays day-precision; contents cannot certify a future publication', async () => {
  const precise = 'https://news.example/cont-future';
  const futureDay = 'https://news.example/future-day';
  const absent = 'https://news.example/absent';
  const lot = await collectExa(env(async (url,init) => {
    if (url===EXA_CONTENTS) {
      assert.deepEqual(JSON.parse(init.body).urls,[first,precise,absent]);
      return json({results:[{...hit(first,'2026-11-23T00:00:00.000Z'),text:'Trecho A'},
        {...hit(precise,'2026-11-23T14:46:00.000Z'),text:'Trecho B'},
        {...hit(absent,'2026-11-23T14:30:00.000Z'),text:'Trecho C'}]});
    }
    return json({results:JSON.parse(init.body).query.includes('inteligência artificial') ? [hit(first,'2026-11-23T00:00:00.000Z'),hit(precise),hit(absent,null),hit(futureDay,'2026-11-24')] : []});
  }),win);
  assert.deepEqual(lot.items.map(i=>i.canonical_url),[absent]);
  assert.equal(lot.items[0].date_source,'contents');
  assert.equal(lot.undated.length,1); assert.equal(lot.undated[0].published_at,null);
  assert.equal(lot.undated[0].reported_day,'2026-11-23');
  assert.equal(lot.counts.out_of_window,2);
  assert.equal(lot.contents.out_of_window,1);
  assert.equal(lot.contents.requested,lot.contents.extracted+lot.contents.failed+lot.contents.out_of_window);
  assert.equal(lot.contents.status,'partial');
});

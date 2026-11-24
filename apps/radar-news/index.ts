import {
  appCron, array, bearer, boolean, defineApp, defineProvider, header, json, mutation, number, object,
  ProviderError, query, router, secrets, string, type MutationContext, type QueryContext,
} from 'apps';
import {dateBrt, publication, record, windowFor} from './src/core.js';
import {collectExa, emptyExa, EXA_HEALTH, MAX_ITEMS, requestJson} from './src/exa.js';
import {annotate, checkJev, jevMeta} from './src/jev.js';

function checkFailure(error: string): never {
  if (error === 'unauthorized') throw new ProviderError({reason:'unauthorized',status:401});
  if (error === 'rate_limited') throw new ProviderError({reason:'rate_limited',status:429});
  throw new ProviderError({reason:'unavailable'});
}
const exa = defineProvider({
  name:'Exa', hosts:['api.exa.ai'],
  auth:{apiKey:secrets({label:'Chave Exa', fields:object({key:string({minLength:1})}), request:({key})=>header('x-api-key',key)})},
  async health(ctx) {
    const result=await requestJson(ctx,EXA_HEALTH,undefined,64*1024,4_000);
    if (!result.ok) checkFailure(result.error);
    const value = record(result.value);
    if (!Array.isArray(value.data) || typeof value.hasMore !== 'boolean') checkFailure('invalid_response');
  },
});
const jev = defineProvider({
  name:'TypeSafe Jev', hosts:['api.typesafe.ai'],
  auth:{apiKey:secrets({label:'Chave TypeSafe', fields:object({key:string({minLength:1})}), request:({key})=>bearer(key)})},
  async health(ctx) { const error=await checkJev(ctx); if(error) checkFailure(error); },
});
const requirements = {sql:true,app:{accounts:{exa:exa.many(),jev:jev.many()}}} as const;
type Write = MutationContext<typeof requirements,'app'>;
type Read = QueryContext<typeof requirements,'app'>;
type Row = {date_brt:string;run_id:string;start_ms:number;status:string;paid_reserved:number;usable:number;reason:string|null;doc:string};
type Lot = ReturnType<typeof emptyExa> & {
  captured_at:string|null;finished_at:string|null;window:{start:string;end:string};jev:ReturnType<typeof jevMeta>;
};
const RUN_MAX_MS = 18_000;
const RUN_STUCK_MS = 30_000;
const accountProblem = (count:number) => count === 1 ? null : count === 0 ? 'missing_account' : 'multiple_accounts';
const visibleStatus = (row:Row) => row.status === 'running' && Date.now() - row.start_ms >= RUN_STUCK_MS ? 'uncertain_no_retry' : row.status;
const byDay = (sql:Read['sql'],date:string) => sql.exec<Row>('SELECT * FROM runs WHERE date_brt = ?',date).toArray()[0];
function summary(row:Row,reused:boolean) {
  return {status:visibleStatus(row),date_brt:row.date_brt,run_id:row.run_id,reason:row.reason,ready:row.usable===1,reused,paid_run_reserved:row.paid_reserved===1};
}
const collect = mutation({
  description:'Pré-coleta o lote de notícias IA/Auto/Apple; uma reserva de execução por dia BRT, sem reenvio.',input:object({}),
  output:object({status:string(),date_brt:string(),run_id:string(),reason:json(),ready:boolean(),reused:boolean(),paid_run_reserved:boolean()}),
}, async (ctx:Write) => {
  const started = new Date();
  const {date_brt,start,end} = windowFor(started);
  const run = date_brt + '-' + crypto.randomUUID();
  const exaAccounts = ctx.app.accounts.exa;
  const preflight = accountProblem(exaAccounts.length);
  const doc:Lot = {...emptyExa('not_attempted'),captured_at:null,finished_at:preflight ? end : null,window:{start,end},jev:jevMeta('not_attempted')};
  // A SQL statement outside a transaction commits on its own, before any API call.
  const claim = ctx.sql.exec(`INSERT INTO runs (date_brt,run_id,start_ms,paid_reserved,status,reason,doc) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(date_brt) DO UPDATE SET run_id=excluded.run_id,start_ms=excluded.start_ms,paid_reserved=excluded.paid_reserved,
    status=excluded.status,reason=excluded.reason,doc=excluded.doc WHERE runs.paid_reserved = 0`,
    date_brt,run,+started,preflight ? 0 : 1,preflight ? 'failed' : 'running',preflight,JSON.stringify(doc));
  if (!claim.rowsWritten || preflight) return summary(byDay(ctx.sql,date_brt)!,!claim.rowsWritten);

  const signal = AbortSignal.any([ctx.signal,AbortSignal.timeout(RUN_MAX_MS)]);
  const fetch = (url:string,init:RequestInit)=>ctx.fetch(url,init);
  let status = 'failed', reason:string|null = null;
  try {
    const {status:exaStatus,...data} = await collectExa({fetch,signal,account:exaAccounts[0]!},{date_brt,start,end});
    Object.assign(doc,data,{captured_at:new Date().toISOString()});
    status = exaStatus;
    if (status === 'failed') reason = 'no_search_coverage';
  } catch { reason='collection_error'; }
  if (status !== 'failed') {
    const accounts = ctx.app.accounts.jev;
    const skipped = accountProblem(accounts.length);
    if (skipped) doc.jev = jevMeta('skipped',skipped);
    else {
      try { doc.jev = await annotate({fetch,signal,account:accounts[0]!},[...doc.items,...doc.undated]); }
      catch { doc.jev = jevMeta('failed','annotation_error'); }
    }
  }
  const usable = status === 'ok' || status === 'no_news' || (status === 'partial' && doc.counts.total > 0);
  doc.finished_at = new Date().toISOString();
  ctx.sql.exec('UPDATE runs SET status=?, usable=?, reason=?, doc=? WHERE date_brt=? AND run_id=? AND status=\'running\'',
    status,usable ? 1 : 0,reason,JSON.stringify(doc),date_brt,run);
  return summary(byDay(ctx.sql,date_brt)!,false);
});

const latest = query({
  description:'Lê o lote de uma data BRT (hoje por padrão), sem reciclar itens anteriores. Paginação: fixe run_id e date_brt entre páginas.',
  input:object({date_brt:string({description:'AAAA-MM-DD em America/Sao_Paulo'}).optional(),run_id:string().optional(),
    offset:number({description:'Inteiro de 0 a 12'}).default(0),limit:number({description:'Inteiro de 1 a 6'}).default(4)}),
  output:object({status:string(),date_brt:string(),ready:boolean(),lot:json(),previous_usable:json(),items:array(json()),undated:array(json()),returned:number(),next_offset:json()}),
}, async (ctx:Read,input) => {
  const date = input.date_brt ?? dateBrt(new Date());
  const {offset,limit,run_id} = input;
  const empty = {date_brt:date,ready:false,lot:null,previous_usable:null,items:[],undated:[],returned:0,next_offset:null};
  if (date.length !== 10 || !publication(date+'T00:00:00Z') || !Number.isInteger(offset) || offset<0 || offset>MAX_ITEMS || !Number.isInteger(limit) || limit<1 || limit>6 || (run_id!==undefined && (run_id.length===0 || run_id.length>64))) {
    return {...empty,date_brt:date.length===10 ? date : '',status:'invalid_input'};
  }
  const previous = ctx.sql.exec<Pick<Row,'date_brt'|'run_id'|'status'>>('SELECT date_brt,run_id,status FROM runs WHERE usable=1 AND date_brt < ? ORDER BY date_brt DESC LIMIT 1',date).toArray()[0] ?? null;
  const row = byDay(ctx.sql,date);
  if (run_id !== undefined && row?.run_id !== run_id) return {...empty,status:'run_mismatch',previous_usable:previous};
  if (!row) return {...empty,status:'not_run',previous_usable:previous};
  const {items,undated,...meta} = JSON.parse(row.doc) as Lot;
  const page = [...items,...undated].slice(offset,offset+limit);
  return {...empty,status:visibleStatus(row),ready:row.usable===1,previous_usable:previous,
    lot:{...meta,run_id:row.run_id,reason:row.reason,paid_run_reserved:row.paid_reserved===1},
    items:page.filter(item=>item.published_at!==null),undated:page.filter(item=>item.published_at===null),
    returned:page.length,next_offset:offset+page.length < meta.counts.total ? offset+page.length : null};
});

export default defineApp(requirements,{
  tools:router({collect,latest}),
  schedules:{pre_coleta:appCron({expression:'0 12 * * MON-FRI',timezone:'America/Sao_Paulo'},collect,{})},
});

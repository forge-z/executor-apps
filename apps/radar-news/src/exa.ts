import { exactUrl, excerpt, publication, record, type Window } from './core.js';

export const EXA_SEARCH = 'https://api.exa.ai/search';
export const EXA_CONTENTS = 'https://api.exa.ai/contents';
export const EXA_HEALTH = 'https://api.exa.ai/monitors?limit=1';
export const JEV_INFER = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODELS = 'https://api.typesafe.ai/v1/models';
type Endpoint = typeof EXA_SEARCH | typeof EXA_CONTENTS | typeof EXA_HEALTH | typeof JEV_INFER | typeof JEV_MODELS;
export type Transport = {fetch: (url: string, init: RequestInit) => Promise<Response>; signal: AbortSignal; account: {headers(): Record<string,string>}};
type Reply = {ok:true; value: unknown} | {ok:false; error:string};
export const REQUEST_CAP = 24 * 1024;
const EXA_RESPONSE_CAP = 192 * 1024;
export const EXA_ROUND_MS = 7_000;

function httpCode(status: number): string {
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 402) return 'payment_required';
  if (status === 429) return 'rate_limited';
  return 'http_' + status;
}

export async function requestJson(env: Transport, endpoint: Endpoint, body: object | undefined, maxBytes: number, ms: number): Promise<Reply> {
  const signal = AbortSignal.any([env.signal, AbortSignal.timeout(ms)]);
  if (signal.aborted) return {ok:false,error:'timeout'};
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stop = () => { void reader?.cancel().catch(() => undefined); };
  let onAbort: () => void = stop;
  const aborted = new Promise<Reply>((resolve) => {
    onAbort = () => { resolve({ok:false,error:'timeout'}); stop(); };
    signal.addEventListener('abort',onAbort,{once:true});
  });
  async function read(): Promise<Reply> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && new TextEncoder().encode(encoded).byteLength > REQUEST_CAP) return {ok:false,error:'request_too_large'};
    try {
      const res = await env.fetch(endpoint, {
        method: body === undefined ? 'GET' : 'POST', redirect:'manual', signal,
        headers:{...env.account.headers(),accept:'application/json',...(body === undefined ? {} : {'content-type':'application/json'})},
        body:encoded,
      });
      reader = res.body?.getReader();
      if (signal.aborted) { stop(); return {ok:false,error:'timeout'}; }
      if (res.status !== 200) { stop(); return {ok:false,error:httpCode(res.status)}; }
      if (Number(res.headers.get('content-length')) > maxBytes) { stop(); return {ok:false,error:'response_too_large'}; }
      if (!reader) return {ok:false,error:'invalid_response'};
      const decoder = new TextDecoder();
      let bytes = 0, text = '';
      for (;;) {
        const part = await reader.read();
        if (signal.aborted) return {ok:false,error:'timeout'};
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) { stop(); return {ok:false,error:'response_too_large'}; }
        text += decoder.decode(part.value,{stream:true});
      }
      try { return {ok:true, value:JSON.parse(text + decoder.decode()) as unknown}; }
      catch { return {ok:false,error:'invalid_response'}; }
    } catch { return {ok:false,error:signal.aborted ? 'timeout' : 'network'}; }
  }
  try { return await Promise.race([aborted, read()]); }
  finally { signal.removeEventListener('abort',onAbort); }
}

const QUERIES = {
  ia:'Notícias recentes de inteligência artificial: lançamentos, pesquisa, empresas, produtos, regulação e impacto no Brasil e no mundo.',
  auto:'Notícias do setor automotivo no Brasil: lançamentos, indústria, mercado, eletrificação, preços, recall e regulação brasileira.',
  apple:'Notícias da Apple com impacto para consumidores brasileiros: lançamentos, iPhone, Mac, atualizações, serviços, preços e disponibilidade no Brasil.',
} as const;
export const PER_SECTION = 4;
export const MAX_ITEMS = 12;
const sections = Object.keys(QUERIES) as (keyof typeof QUERIES)[];
type Section = keyof typeof QUERIES;
type Hit = {section: Section; rank: number; source_url: string; title: string; published_at: string | null; reported_day: string | null};
export type Annotation = {duplicate_of: string; confidence: number};
export type Item = {
  canonical_url:string; source_url:string; title:string; sections:Section[]; provenance:Hit[];
  published_at:string|null; reported_day:string|null; date_source:'search'|'contents'|null; excerpt:string|null; excerpt_kind:'text'|'highlight'|null;
  extraction:'ok'|'provider_error'|'missing_excerpt'|'batch_failed'; jev?:Annotation;
};
const initialSearch = (status: string) => ({status, sampled:0, returned:0, malformed:0, out_of_window:0, warnings:0});
const initialContents = (status: string) => ({status, requested:0, extracted:0, failed:0, reported_errors:0, out_of_window:0});
export const emptyExa = (status: string) => ({
  searches:{ia:initialSearch(status),auto:initialSearch(status),apple:initialSearch(status)}, contents:initialContents(status),
  counts:{items:0,undated:0,total:0,exact_duplicate_hits:0,out_of_window:0}, items:[] as Item[], undated:[] as Item[],
});
function exaDate(raw: unknown, win: Window) {
  const exact = publication(raw);
  // Exa serializes day-only estimates as UTC midnight. Treat them conservatively.
  const day = typeof raw === 'string' && /^\d{4}-\d\d-\d\d$/.test(raw) && publication(raw + 'T00:00:00Z') ? raw :
    exact?.endsWith('T00:00:00.000Z') ? exact.slice(0,10) : null;
  const date = day ? null : exact;
  const outside = date ? Date.parse(date) < Date.parse(win.start) || Date.parse(date) > Date.parse(win.end) :
    day !== null && (day < win.start.slice(0,10) || day > win.end.slice(0,10));
  return {day,date,outside};
}

export async function collectExa(env: Transport, win: Window) {
  const out = emptyExa('not_needed');
  const replies = await Promise.all(sections.map(section => requestJson(env, EXA_SEARCH, {
    query:QUERIES[section], type:'auto', numResults:PER_SECTION, startPublishedDate:win.start, endPublishedDate:win.end,
  }, EXA_RESPONSE_CAP, EXA_ROUND_MS)));
  const known = new Map<string,Item>();
  let successful = 0, incomplete = false;
  for (const [idx, section] of sections.entries()) {
    const reply = replies[idx]!;
    const value = reply.ok ? record(reply.value) : {};
    const results = value.results;
    const diag = out.searches[section];
    if (!Array.isArray(results)) { diag.status = reply.ok ? 'invalid_response' : reply.error; incomplete = true; continue; }
    successful++;
    diag.status = 'ok';
    diag.returned = results.length;
    diag.warnings = Array.isArray(value.warnings) ? value.warnings.length : 0;
    const sample = results.slice(0,PER_SECTION);
    diag.sampled = sample.length;
    for (const [i, raw] of sample.entries()) {
      const h = record(raw);
      const url = exactUrl(h.url), title = excerpt(h.title,180), {date,day,outside} = exaDate(h.publishedDate,win);
      if (!url || !title) { diag.malformed++; continue; }
      if (outside) { diag.out_of_window++; continue; }
      const hit = {section,rank:i+1,source_url:h.url as string,title,published_at:date,reported_day:day};
      const current = known.get(url);
      if (current) {
        out.counts.exact_duplicate_hits++;
        current.provenance.push(hit);
        if (!current.sections.includes(section)) current.sections.push(section);
        current.reported_day ??= day;
        if (!current.published_at && date) { current.published_at = date; current.date_source = 'search'; }
      } else {
        known.set(url,{canonical_url:url,source_url:hit.source_url,title,sections:[section],provenance:[hit],
          published_at:date,reported_day:day,date_source:date?'search':null,excerpt:null,excerpt_kind:null,extraction:'batch_failed'});
      }
    }
    out.counts.out_of_window += diag.out_of_window;
    if (diag.malformed || diag.warnings || results.length > PER_SECTION) incomplete = true;
  }
  if (known.size) {
    const batch = await requestJson(env, EXA_CONTENTS, {urls:[...known.keys()],text:{maxCharacters:720},highlights:{maxCharacters:400},livecrawlTimeout:3500}, EXA_RESPONSE_CAP, EXA_ROUND_MS);
    const payload = batch.ok ? record(batch.value) : {};
    const results = Array.isArray(payload.results) ? payload.results : null;
    const statuses = Array.isArray(payload.statuses) ? payload.statuses : null;
    const diag = initialContents(batch.ok ? (results || statuses ? 'ok' : 'invalid_response') : batch.error);
    out.contents = diag;
    diag.requested = known.size;
    const errors = new Set<string>();
    for (const value of statuses?.slice(0,MAX_ITEMS*2) ?? []) {
      const s = record(value), url = exactUrl(s.id);
      if (url && known.has(url) && s.status === 'error') errors.add(url);
    }
    diag.reported_errors = errors.size;
    const matched = new Map<string,Record<string,unknown>>();
    for (const value of results?.slice(0,MAX_ITEMS*2) ?? []) {
      const r = record(value), url = exactUrl(r.url);
      if (url && known.has(url) && !matched.has(url)) matched.set(url,r);
    }
    for (const [url, item] of known) {
      if (errors.has(url)) item.extraction = 'provider_error';
      else if (diag.status === 'ok') {
        const found = matched.get(url);
        const {date,day,outside} = exaDate(found?.publishedDate,win);
        if (outside) { out.counts.out_of_window++; diag.out_of_window++; known.delete(url); incomplete = true; continue; }
        item.reported_day ??= day;
        if (date && !item.published_at) { item.published_at = date; item.date_source = 'contents'; }
        const text = excerpt(found?.text,720);
        const highlights = Array.isArray(found?.highlights) ? found.highlights : [];
        const highlight = highlights.slice(0,4).map(v=>excerpt(v,400)).find(Boolean);
        item.excerpt = text || highlight || null;
        item.excerpt_kind = text ? 'text' : highlight ? 'highlight' : null;
        item.extraction = item.excerpt ? 'ok' : 'missing_excerpt';
      }
      if (item.extraction === 'ok') diag.extracted++;
      else diag.failed++;
    }
    if ((diag.failed || diag.out_of_window) && diag.status === 'ok') diag.status = 'partial';
    incomplete ||= diag.failed > 0;
  }
  for (const item of known.values()) (item.published_at ? out.items : out.undated).push(item);
  Object.assign(out.counts,{items:out.items.length,undated:out.undated.length,total:known.size});
  const status = successful === 0 ? 'failed' : incomplete || (out.items.length === 0 && out.undated.length > 0) ? 'partial' : !known.size ? 'no_news' : 'ok';
  return {...out,status};
}

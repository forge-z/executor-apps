import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { beforeEach } from 'node:test';
import { createAppHandler, hostContext } from 'apps/host';
import app from '../build/index.js';

const model = 'text-embedding-3-small';
const api = 'https://api.openai.com/v1';
const dummyKey = 'dummy-offline-fixture';
const upstreamSecret = 'synthetic-private-upstream-error';
const migration = 'migrations/0001_memory.sql';
const files = [{ path: migration, content: readFileSync(new URL('../' + migration, import.meta.url), 'utf8') }];

let requests;
let respond;
beforeEach(t => {
  requests = [];
  respond = () => { throw new Error('Unexpected synthetic fetch'); };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const request = {
      url: String(url),
      method: init.method,
      redirect: init.redirect,
      authorization: new Headers(init.headers).get('authorization'),
      contentType: new Headers(init.headers).get('content-type'),
      body: init.body === undefined ? undefined : await new Response(init.body).json(),
      signal: init.signal,
    };
    requests.push(request);
    return respond(request);
  });
});

async function host(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let transactionDepth = 0;
  const storage = {
    sql: {
      exec(sql, ...bindings) {
        const empty = { columnNames: [], rowsRead: 0, rowsWritten: 0, toArray: () => [] };
        if (sql.trim().includes(';') && !bindings.length) {
          db.exec(sql);
          return empty;
        }
        const statement = db.prepare(sql);
        const columnNames = statement.columns().map(column => column.name);
        if (!columnNames.length) {
          return { ...empty, rowsWritten: Number(statement.run(...bindings).changes) };
        }
        const rows = statement.all(...bindings).map(row => ({ ...row }));
        return { ...empty, columnNames, rowsRead: rows.length, toArray: () => rows };
      },
    },
    transactionSync(work) {
      const savepoint = 'fixture_' + transactionDepth++;
      db.exec('SAVEPOINT ' + savepoint);
      try {
        const result = work();
        db.exec('RELEASE ' + savepoint);
        return result;
      } catch (error) {
        db.exec('ROLLBACK TO ' + savepoint + '; RELEASE ' + savepoint);
        throw error;
      } finally {
        transactionDepth--;
      }
    },
  };
  const handle = createAppHandler(app);
  async function request(payload, accounts = { openai: [] }) {
    const response = await handle(new Request('https://executor.local/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }), { ...hostContext({ app: accounts, user: {} }), storage, files });
    return { status: response.status, body: await response.json() };
  }
  async function success(payload, accounts) {
    const result = await request(payload, accounts);
    assert.equal(result.status, 200, JSON.stringify(result.body.error));
    return result.body.value;
  }
  const requirementsReply = await request({ operation: 'requirements' });
  assert.equal(requirementsReply.status, 200);
  const requirements = requirementsReply.body.value;
  await success({ operation: 'migrate' });
  const account = (id = 'acc_fixture') => ({
    id,
    provider: requirements.accounts.app.openai.definition,
    method: 'apiKey',
    fields: { key: dummyKey },
  });
  return {
    request, success, requirements, account,
    accounts: () => ({ openai: [account()] }),
    inTransaction: () => transactionDepth !== 0,
    retain: (input, accounts) => success({ operation: 'call', tool: 'retain', kind: 'mutation', input }, accounts),
    recall: (input, accounts) => success({ operation: 'call', tool: 'recall', kind: 'query', input }, accounts),
  };
}

function embedding(axis, scale = 1) {
  return Response.json({
    object: 'list',
    model,
    data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: 256 }, (_, i) => i === axis ? scale : 0) }],
    usage: { prompt_tokens: 5, total_tokens: 5 },
  });
}

test('real SDK migration and two scoped tools support accent-insensitive lexical recall without fetch', async t => {
  const h = await host(t);
  assert.equal(h.requirements.sql, true);
  assert.deepEqual(Object.keys(h.requirements.accounts.app), ['openai']);
  assert.deepEqual(h.requirements.accounts.user, {});
  assert.equal(h.requirements.accounts.app.openai.cardinality, 'many');
  assert.deepEqual(h.requirements.accounts.app.openai.definition.hosts, ['api.openai.com']);
  const catalog = await h.success({ operation: 'inspect' });
  assert.deepEqual(catalog.tools.map(tool => [tool.name, tool.readOnly]).sort(), [['recall', true], ['retain', false]]);
  for (const tool of catalog.tools) {
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), tool.name === 'recall' ? ['limit', 'query'] : ['key', 'text']);
    assert.ok(tool.outputSchema);
  }

  assert.deepEqual(await h.retain({ key: 'favorito', text: '  Açúcar e café.  ' }), {
    status: 'stored', key: 'favorito', embedding: 'missing_account',
  });
  await h.retain({ key: 'outro', text: 'Prefiro chá.' });
  assert.deepEqual(await h.recall({ query: '  ACUCAR cafe  ' }), {
    status: 'ok', mode: 'lexical', embedding: 'missing_account',
    results: [{ key: 'favorito', text: 'Açúcar e café.' }],
  });
  assert.deepEqual((await h.recall({ query: 'helicóptero' })).results, []);
  assert.equal(requests.length, 0);
});

test('corrections replace current text, and each installation owns its SQLite data', async t => {
  const h = await host(t);
  const other = await host(t);
  await h.retain({ key: 'local', text: 'Recife' });
  assert.equal((await h.retain({ key: 'local', text: ' Recife ' })).status, 'unchanged');
  assert.equal((await h.retain({ key: 'local', text: 'Olinda' })).status, 'stored');
  assert.deepEqual((await h.recall({ query: 'Recife' })).results, []);
  assert.deepEqual((await h.recall({ query: 'Olinda' })).results, [{ key: 'local', text: 'Olinda' }]);
  const attempt = await other.request({
    operation: 'call', tool: 'recall', kind: 'query', input: { query: 'Olinda', bank_id: 'local' },
  });
  if (attempt.status === 200) assert.deepEqual(attempt.body.value.results, []);
  else assert.ok(attempt.status >= 400);
  assert.deepEqual((await other.recall({ query: 'Olinda' })).results, []);
  assert.equal(requests.length, 0);
});

test('a paraphrase matches a retained vector while orthogonal facts stay out and replays skip embedding', async t => {
  const h = await host(t);
  const accounts = h.accounts();
  const fact = 'Meu cachorro costuma latir.';
  const distractor = 'A rua fica movimentada cedo.';
  const paraphrase = 'Qual animal doméstico faz barulho?';
  respond = request => embedding(request.body.input === distractor ? 1 : 0, 7);
  assert.equal((await h.recall({ query: paraphrase }, accounts)).embedding, 'no_vectors');
  assert.equal(requests.length, 0);
  assert.equal((await h.retain({ key: 'pet', text: fact }, accounts)).embedding, 'stored');
  assert.equal((await h.retain({ key: 'rua', text: distractor }, accounts)).embedding, 'stored');
  assert.deepEqual(await h.retain({ key: 'pet', text: ' ' + fact }, accounts), {
    status: 'unchanged', key: 'pet', embedding: 'stored',
  });
  assert.deepEqual((await h.recall({ query: paraphrase })).results, []);
  assert.deepEqual(await h.recall({ query: ' ' + paraphrase }, accounts), {
    status: 'ok', mode: 'semantic', embedding: 'used', results: [{ key: 'pet', text: fact }],
  });
  assert.deepEqual(requests.map(request => request.body), [fact, distractor, paraphrase].map(input => ({
    model, input, dimensions: 256, encoding_format: 'float',
  })));
  for (const request of requests) {
    assert.equal(request.url, api + '/embeddings');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.authorization, 'Bearer ' + dummyKey);
    assert.equal(request.contentType, 'application/json');
    assert.ok(request.signal instanceof AbortSignal);
  }
});

test('ambiguous accounts, auth errors, malformed or large bodies and network errors fall back safely', async t => {
  const h = await host(t);
  const accounts = h.accounts();
  const multiple = { openai: [h.account(), h.account('acc_fixture_two')] };
  assert.equal((await h.retain({ key: 'one', text: 'Café' }, multiple)).embedding, 'multiple_accounts');
  assert.equal((await h.recall({ query: 'cafe' }, multiple)).embedding, 'multiple_accounts');
  assert.equal((await h.recall({ query: 'cafe' }, accounts)).embedding, 'no_vectors');
  assert.equal(requests.length, 0);
  respond = () => embedding(0);
  await h.retain({ key: 'two', text: 'Chá' }, accounts);
  respond = () => Response.json({ error: { message: upstreamSecret } }, { status: 401 });
  const saved = await h.retain({ key: 'three', text: 'Café puro' }, accounts);
  assert.deepEqual(saved, { status: 'stored', key: 'three', embedding: 'unauthorized' });
  for (const [fixture, state] of [
    [respond, 'unauthorized'],
    [() => Response.json({ model, data: [{ index: 0, embedding: [1] }], secret: upstreamSecret }), 'invalid_response'],
    [() => embedding(-1), 'invalid_response'],
    [() => new Response(' '.repeat(70_000) + upstreamSecret), 'invalid_response'],
    [() => { throw new Error(upstreamSecret); }, 'network_error'],
  ]) {
    respond = fixture;
    const result = await h.recall({ query: 'cafe' }, accounts);
    assert.deepEqual(result, {
      status: 'ok', mode: 'lexical', embedding: state,
      results: [{ key: 'one', text: 'Café' }, { key: 'three', text: 'Café puro' }],
    });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(upstreamSecret + '|' + dummyKey));
  }
  assert.equal(requests.length, 7);
});

test('input bounds reject without truncation and a full store still accepts corrections', async t => {
  const h = await host(t);
  for (const key of ['A', '-bad', 'a'.repeat(65), 'a\n']) {
    assert.equal((await h.retain({ key, text: 'ok' })).status, 'invalid_input');
  }
  for (const text of ['  ', 'x'.repeat(601)]) {
    assert.equal((await h.retain({ key: 'valid', text })).status, 'invalid_input');
  }
  for (const input of [{ query: ' ' }, { query: 'x'.repeat(301) }, { query: 'lote', limit: 0 },
    { query: 'lote', limit: 5.1 }, { query: 'lote', limit: 6 }]) {
    assert.equal((await h.recall(input)).status, 'invalid_input');
  }
  for (let i = 0; i < 300; i++) {
    const key = 'key.' + String(i).padStart(3, '0');
    const text = i === 0 ? 'z'.repeat(600) : 'lote';
    assert.equal((await h.retain({ key, text })).status, 'stored');
  }
  assert.deepEqual(await h.retain({ key: 'extra', text: 'único' }, h.accounts()), {
    status: 'full', key: 'extra', embedding: 'not_attempted',
  });
  assert.equal((await h.retain({ key: 'key.000', text: 'lote' })).status, 'stored');
  assert.deepEqual((await h.recall({ query: 'lote' })).results.map(row => row.key), ['key.000', 'key.001', 'key.002']);
  assert.equal((await h.recall({ query: 'lote', limit: 5 })).results.length, 5);
  assert.deepEqual((await h.recall({ query: 'único' })).results, []);
  assert.equal(requests.length, 0);
});

test('late enrichment cannot attach an old vector to a corrected fact', { timeout: 6000 }, async t => {
  const h = await host(t);
  const accounts = h.accounts();
  let releaseOld;
  let observeOld;
  const oldStarted = new Promise(resolve => { observeOld = resolve; });
  const oldReply = new Promise(resolve => { releaseOld = resolve; });
  const transactionStates = [];
  respond = request => {
    transactionStates.push(h.inTransaction());
    if (request.body.input === 'Versão antiga') {
      observeOld();
      return oldReply;
    }
    return embedding(request.body.input === 'Versão atual' ? 1 : 0);
  };
  const pending = h.retain({ key: 'fact', text: 'Versão antiga' }, accounts);
  try {
    await Promise.race([oldStarted, pending.then(() => assert.fail('retain did not request an embedding'))]);
    assert.equal((await h.retain({ key: 'fact', text: 'Versão antiga' }, accounts)).status, 'unchanged');
    assert.equal((await h.retain({ key: 'fact', text: 'Versão atual' }, accounts)).embedding, 'stored');
  } finally {
    releaseOld(embedding(0));
    await pending;
  }
  assert.equal((await pending).embedding, 'superseded');
  assert.deepEqual((await h.recall({ query: 'antiga' }, accounts)).results, []);
  assert.deepEqual((await h.recall({ query: 'atual' })).results, [{ key: 'fact', text: 'Versão atual' }]);
  assert.deepEqual(transactionStates, [false, false, false]);
});

test('account health checks only the model endpoint and classifies failures without leaking bodies', async t => {
  const h = await host(t);
  const check = () => h.request({ operation: 'account-check', requirement: 'openai' }, { openai: h.account() });
  respond = () => Response.json({ id: model, object: 'model', created: 1, owned_by: 'openai' });
  assert.equal((await check()).status, 200);
  respond = () => Response.json({ error: { message: upstreamSecret } }, { status: 401 });
  const rejected = await check();
  assert.match(JSON.stringify(rejected.body), /unauthorized/);
  assert.doesNotMatch(JSON.stringify(rejected.body), new RegExp(upstreamSecret + '|' + dummyKey));
  respond = () => Response.json({ id: 'other-model' });
  const wrongModel = await check();
  assert.equal(wrongModel.status, 502);
  assert.match(JSON.stringify(wrongModel.body), /unavailable/);
  assert.deepEqual(requests.map(({ url, method, redirect, authorization, body }) => [
    url, method, redirect, authorization, body,
  ]), Array.from({ length: 3 }, () => [api + '/models/' + model, 'GET', 'manual', 'Bearer ' + dummyKey, undefined]));
});

test('a stalled embedding response times out and leaves lexical recall usable', { timeout: 6000 }, async t => {
  const h = await host(t);
  const accounts = h.accounts();
  respond = () => embedding(0);
  assert.equal((await h.retain({ key: 'fact', text: 'Café' }, accounts)).embedding, 'stored');

  const keepAlive = setTimeout(() => {}, 5000);
  t.after(() => clearTimeout(keepAlive));
  respond = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([123])); },
  }));
  assert.deepEqual(await h.recall({ query: 'cafe' }, accounts), {
    status: 'ok', mode: 'lexical', embedding: 'timeout', results: [{ key: 'fact', text: 'Café' }],
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].signal.aborted, true);
});

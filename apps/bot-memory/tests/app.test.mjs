import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { beforeEach } from 'node:test';
import { createAppHandler, hostContext } from 'apps/host';
import { AppUiApi } from 'apps/ui/contracts';
import app from '../build/index.js';

const model = 'text-embedding-3-small';
const api = 'https://api.openai.com/v1';
const dummyKey = 'dummy-offline-fixture';
const upstreamSecret = 'synthetic-private-upstream-error';
const migrations = new URL('../migrations/', import.meta.url);
const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort().map(name => ({
  path: 'migrations/' + name, content: readFileSync(new URL(name, migrations), 'utf8'),
}));

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

async function host(t, seedLegacy, legacyMigrationCount = 1) {
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
  async function request(payload, accounts = { openai: [] }, approval, packageFiles = files) {
    const response = await handle(new Request('https://executor.local/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }), { ...hostContext({ app: accounts, user: {} }, approval), storage, files: packageFiles });
    return { status: response.status, body: await response.json() };
  }
  async function success(payload, accounts, approval, packageFiles) {
    const result = await request(payload, accounts, approval, packageFiles);
    assert.equal(result.status, 200, JSON.stringify(result.body.error));
    return result.body.value;
  }
  const requirementsReply = await request({ operation: 'requirements' });
  assert.equal(requirementsReply.status, 200);
  const requirements = requirementsReply.body.value;
  if (seedLegacy) {
    await success({ operation: 'migrate' }, undefined, undefined, files.slice(0, legacyMigrationCount));
    seedLegacy(db);
  }
  await success({ operation: 'migrate' });
  const account = (id = 'acc_fixture') => ({
    id,
    provider: requirements.accounts.app.openai.definition,
    method: 'apiKey',
    fields: { key: dummyKey },
  });
  return {
    db, request, success, requirements, account,
    accounts: () => ({ openai: [account()] }),
    inTransaction: () => transactionDepth !== 0,
    retain: (input, accounts) => success({ operation: 'call', tool: 'retain', kind: 'mutation', input }, accounts),
    recall: (input, accounts) => success({ operation: 'call', tool: 'recall', kind: 'query', input }, accounts),
    list: (input = {}) => success({ operation: 'query', name: 'admin.list', input }, { openai: [account()] }),
    forget: input => success(
      { operation: 'call', tool: 'admin.forget', kind: 'mutation', input },
      { openai: [account()] }, { tool: 'admin.forget', input },
    ),
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

test('real SDK migration and retained bot tools support accent-insensitive lexical recall without fetch', async t => {
  const h = await host(t);
  assert.equal(h.requirements.sql, true);
  assert.deepEqual(Object.keys(h.requirements.accounts.app), ['openai']);
  assert.deepEqual(h.requirements.accounts.user, {});
  assert.equal(h.requirements.accounts.app.openai.cardinality, 'many');
  assert.deepEqual(h.requirements.accounts.app.openai.definition.hosts, ['api.openai.com']);
  const catalog = await h.success({ operation: 'inspect', tools: ['retain', 'recall'] });
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

test('admin list reads legacy facts with bounded key cursors and literal key/text filters', async t => {
  const special = "  Café %_\\ ' <script>  ";
  const h = await host(t, db => {
    const insert = db.prepare('INSERT INTO memory VALUES (?, ?, ?, ?)');
    insert.run('zulu', 'Café without punctuation', 1, null);
    insert.run('alpha_1', special, 7, JSON.stringify([1, 2, 3]));
    insert.run('alpha-1', 'Different fact', 2, null);
  });
  assert.deepEqual(await h.list({ limit: 2 }), {
    status: 'ok', rows: [
      { key: 'alpha-1', text: 'Different fact', revision: 2, history: [] },
      { key: 'alpha_1', text: special, revision: 7, history: [] },
    ], nextCursor: 'alpha_1',
  });
  assert.deepEqual(await h.list({ cursor: 'alpha_1', limit: 2 }), {
    status: 'ok', rows: [{ key: 'zulu', text: 'Café without punctuation', revision: 1, history: [] }], nextCursor: null,
  });
  assert.deepEqual((await h.list({ cursor: 'alpha.1', limit: 1 })).rows.map(row => row.key), ['alpha_1']);
  for (const filter of ['%', '_', '\\', "'", ' <script>  ', 'alpha_1']) {
    assert.deepEqual((await h.list({ filter })).rows.map(row => row.key), ['alpha_1'], filter);
  }
  assert.deepEqual(await h.list({ filter: 'Café', limit: 1 }), {
    status: 'ok', rows: [{ key: 'alpha_1', text: special, revision: 7, history: [] }], nextCursor: 'alpha_1',
  });
  assert.deepEqual((await h.list({ filter: 'Café', cursor: 'alpha_1', limit: 1 })).rows.map(row => row.key), ['zulu']);
  assert.deepEqual(await h.list({ filter: "' OR 1=1 --" }), { status: 'ok', rows: [], nextCursor: null });
  for (const input of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { cursor: 'ALPHA_1' }, { filter: 'x'.repeat(601) }]) {
    assert.deepEqual(await h.list(input), { status: 'invalid_input', rows: [], nextCursor: null });
  }
  const insert = h.db.prepare('INSERT INTO memory (key, text, revision) VALUES (?, ?, 1)');
  for (let i = 0; i < 51; i++) insert.run(`key.${String(i).padStart(2, '0')}`, 'Bounded list');
  assert.equal((await h.list()).rows.length, 25);
  assert.equal((await h.list({ limit: 50 })).rows.length, 50);
  assert.equal(requests.length, 0);
});

test('history migration preserves current facts and tombstones from 0002', async t => {
  const h = await host(t, db => {
    db.prepare('INSERT INTO memory VALUES (?, ?, ?, ?)').run('legacy', 'Legacy text', 3, '[1,2,3]');
    db.prepare('INSERT INTO memory_tombstones VALUES (?)').run('forgotten');
  }, 2);
  assert.deepEqual((await h.list()).rows, [{ key: 'legacy', text: 'Legacy text', revision: 3, history: [] }]);
  assert.equal(h.db.prepare('SELECT embedding FROM memory WHERE key = ?').get('legacy').embedding, '[1,2,3]');
  assert.equal((await h.retain({ key: 'forgotten', text: 'Still blocked' })).status, 'forgotten');
  assert.equal((await h.retain({ key: 'legacy', text: 'Updated text' })).status, 'stored');
  assert.deepEqual((await h.list()).rows[0].history, [{ revision: 3, text: 'Legacy text' }]);
});

test('admin list returns prior text newest first without including it in filters or recall', async t => {
  const h = await host(t);
  const key = 'profile';
  await h.retain({ key, text: 'First fact' });
  assert.deepEqual((await h.list()).rows, [{ key, text: 'First fact', revision: 1, history: [] }]);
  await h.retain({ key, text: 'Second fact' });
  assert.equal((await h.retain({ key, text: ' Second fact ' })).status, 'unchanged');
  await h.retain({ key, text: 'Third fact' });
  assert.deepEqual(await h.list({ filter: 'Third' }), {
    status: 'ok', rows: [{
      key, text: 'Third fact', revision: 3, history: [
        { revision: 2, text: 'Second fact' },
        { revision: 1, text: 'First fact' },
      ],
    }], nextCursor: null,
  });
  assert.deepEqual((await h.list({ filter: 'First' })).rows, []);
  assert.deepEqual((await h.recall({ query: 'First' })).results, []);
});

test('a current-row update failure rolls back the history insert', async t => {
  const h = await host(t);
  await h.retain({ key: 'atomic', text: 'Keep on failure' });
  const before = (await h.list()).rows;
  h.db.exec(`CREATE TRIGGER reject_update BEFORE UPDATE ON memory
    BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
  const response = await h.request({
    operation: 'call', tool: 'retain', kind: 'mutation', input: { key: 'atomic', text: 'Do not store' },
  }, h.accounts());
  assert.equal(response.body.error._tag, 'HostOperationFailed');
  assert.deepEqual((await h.list()).rows, before);
  assert.equal(requests.length, 0);
});

test('admin catalog is namespaced and both tool and browser-shaped mutations require exact-call host approval', async t => {
  const h = await host(t);
  const catalog = await h.success({ operation: 'inspect', detail: 'summary' });
  assert.deepEqual(catalog.tools.map(tool => [tool.name, tool.readOnly]).sort(), [
    ['admin.forget', false], ['admin.list', true], ['recall', true], ['retain', false],
  ]);
  const { tools } = await h.success({ operation: 'inspect', tools: ['admin.forget', 'admin.list'] });
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(),
      tool.name === 'admin.forget' ? ['expectedRevision', 'key'] : ['cursor', 'filter', 'limit']);
    assert.ok(tool.outputSchema);
  }

  await h.retain({ key: 'ready', text: 'Pending approval' });
  assert.deepEqual(await h.success({ operation: 'call', tool: 'admin.list', kind: 'query', input: {} }), await h.list());
  const uiEndpoints = AppUiApi.groups.ui.endpoints;
  assert.deepEqual(Object.keys(uiEndpoints).sort(), ['mutate', 'query', 'subscribe']);
  assert.equal(uiEndpoints.mutate.path, '/_executor/api/mutate');
  const input = { key: 'ready', expectedRevision: 1 };
  const call = { operation: 'call', tool: 'admin.forget', kind: 'mutation', input };
  const browser = { operation: 'mutate', name: 'admin.forget', input };
  for (const payload of [call, browser]) {
    const response = await h.request(payload);
    assert.equal(response.status, 409, JSON.stringify(response.body.error));
    assert.equal(response.body.error._tag, 'HostToolApprovalRequired');
    assert.deepEqual(response.body.error.input, input);
    assert.equal(response.body.error.elicitation.mode, 'form');
  }
  const forged = await h.request({ ...browser, approval: { tool: 'admin.forget', input } });
  assert.ok(forged.status >= 400);
  const wrong = await h.request(call, undefined, { tool: 'admin.forget', input: { ...input, expectedRevision: 2 } });
  assert.equal(wrong.body.error._tag, 'HostInputInvalid');
  assert.equal((await h.list()).rows[0].key, 'ready');
  assert.deepEqual(await h.forget(input), { status: 'forgotten' });
  assert.deepEqual((await h.list()).rows, []);
  assert.equal(requests.length, 0);
});

test('forget rejects stale and invalid requests, deletes the exact row, and fences repeat retain', async t => {
  const h = await host(t, db => {
    const insert = db.prepare('INSERT INTO memory VALUES (?, ?, ?, ?)');
    insert.run('exact_key', 'Original fact', 4, '[1,2,3]');
    insert.run('exact-key', 'Unrelated fact', 1, '[4,5,6]');
  });
  const original = (await h.list({ filter: 'exact_key' })).rows[0];
  await h.retain({ key: original.key, text: 'Corrected fact' });
  assert.deepEqual(await h.forget({ key: original.key, expectedRevision: original.revision }), { status: 'stale_revision' });
  const current = (await h.list({ filter: 'exact_key' })).rows[0];
  assert.deepEqual(current, {
    key: original.key, text: 'Corrected fact', revision: 5, history: [{ revision: 4, text: original.text }],
  });
  for (const [key, expectedRevision] of [['EXACT_KEY', 5], ['exact_key ', 5], ['%', 5], ['exact_key', 0],
    ['exact_key', 1.5], ['exact_key', Number.MAX_SAFE_INTEGER + 1]]) {
    assert.deepEqual(await h.forget({ key, expectedRevision }), { status: 'invalid_input' });
  }
  assert.deepEqual(await h.forget({ key: 'absent', expectedRevision: 1 }), { status: 'not_found' });
  h.db.prepare('UPDATE memory SET embedding = ? WHERE key = ?').run('[1,0,0]', current.key);
  const args = { key: current.key, expectedRevision: current.revision };
  assert.deepEqual(await h.forget(args), { status: 'forgotten' });
  assert.deepEqual(await h.forget(args), { status: 'already_forgotten' });
  assert.deepEqual(await h.retain({ key: current.key, text: 'Try to recreate' }, h.accounts()), {
    status: 'forgotten', key: current.key, embedding: 'not_attempted',
  });
  assert.deepEqual((await h.list({ filter: current.key })).rows, []);
  assert.deepEqual((await h.recall({ query: 'corrected' })).results, []);
  assert.deepEqual(h.db.prepare('SELECT * FROM memory').all().map(row => ({ ...row })), [
    { key: 'exact-key', text: 'Unrelated fact', revision: 1, embedding: '[4,5,6]' },
  ]);
  assert.deepEqual(h.db.prepare('SELECT * FROM memory_tombstones').all().map(row => ({ ...row })), [{ key: current.key }]);
  assert.deepEqual(h.db.prepare('SELECT * FROM memory_history').all(), []);
  assert.equal(requests.length, 0);
});

test('a tombstone write failure leaves the entire fact intact', async t => {
  const h = await host(t);
  await h.retain({ key: 'atomic', text: 'Keep on failure' });
  await h.retain({ key: 'atomic', text: 'Keep this revision too' });
  const before = (await h.list()).rows;
  h.db.exec(`CREATE TRIGGER reject_tombstone BEFORE INSERT ON memory_tombstones
    BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
  const input = { key: 'atomic', expectedRevision: 2 };
  const response = await h.request({ operation: 'mutate', name: 'admin.forget', input }, undefined,
    { tool: 'admin.forget', input });
  assert.equal(response.body.error._tag, 'HostOperationFailed');
  assert.deepEqual((await h.list()).rows, before);
  assert.deepEqual(h.db.prepare('SELECT * FROM memory_tombstones').all(), []);
  assert.equal(requests.length, 0);
});

test('forget fences a retain while its embedding request is pending', { timeout: 6000 }, async t => {
  const h = await host(t);
  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  respond = () => {
    started.resolve();
    return reply.promise;
  };
  const pending = h.retain({ key: 'in-flight', text: 'Synthetic pending fact' }, h.accounts());
  try {
    await Promise.race([started.promise, pending.then(() => assert.fail('retain did not request an embedding'))]);
    const [row] = (await h.list()).rows;
    assert.deepEqual(await h.forget({ key: row.key, expectedRevision: row.revision }), { status: 'forgotten' });
    assert.equal((await h.retain({ key: row.key, text: 'Stale suggestion' }, h.accounts())).status, 'forgotten');
  } finally {
    reply.resolve(embedding(0));
    await pending;
  }
  assert.equal((await pending).embedding, 'superseded');
  assert.deepEqual((await h.list()).rows, []);
  assert.equal(requests.length, 1);
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

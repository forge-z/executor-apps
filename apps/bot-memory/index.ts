import {
  array, defineApp, jsonSchema, mutation, number, object, query, router, string,
  type Infer, type MutationContext, type QueryContext, type Schema, type SqlReader,
} from "apps";
import { embed, normalizeVector, openai, providerFailures } from "./src/openai.js";

const requirements = { app: { accounts: { openai: openai.many() } } };
const capacity = 300;
const minimumCosine = 0.65;
const keyPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const stopwords = new Set("a ao aos as com da das de do dos e em na nas no nos o os ou para por que se um uma the an of and in to is for".split(" "));

type ReadContext = QueryContext<typeof requirements>;
type WriteContext = MutationContext<typeof requirements>;
const accountStates = ["missing_account", "multiple_accounts"] as const;
const embeddingStates = [...accountStates, ...providerFailures, "not_attempted"] as const;
const fact = object({ key: string(), text: string() });
type Fact = Infer<typeof fact>;
type MemoryRow = Fact & { revision: number; embedding: string | null };

function choice<const T extends string>(values: readonly T[]): Schema<T> {
  return jsonSchema({ type: "string", enum: values }) as Schema<T>;
}

const retainOutput = object({
  status: choice(["invalid_input", "full", "unchanged", "stored"]),
  key: jsonSchema({ type: ["string", "null"] }) as Schema<string | null>,
  embedding: choice([...embeddingStates, "stored", "superseded"]),
});
const recallOutput = object({
  status: choice(["invalid_input", "ok"]),
  mode: choice(["lexical", "semantic"]),
  embedding: choice([...embeddingStates, "used", "no_vectors"]),
  results: array(fact),
});
type RetainResult = Infer<typeof retainOutput>;
type RecallResult = Infer<typeof recallOutput>;

function selectAccount(accounts: ReadContext["app"]["accounts"]["openai"]) {
  if (accounts.length === 1) return { account: accounts[0] } as const;
  const reason = accounts.length === 0 ? "missing_account" : "multiple_accounts";
  return { reason } as const;
}

function validLength(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max * 2 && [...value].length <= max;
}

function storedVector(embedding: string | null): number[] | undefined {
  if (embedding === null) return;
  try {
    return normalizeVector(JSON.parse(embedding));
  } catch {
    return undefined;
  }
}

function words(text: string): Set<string> {
  const normalized = text.normalize("NFKD").toLocaleLowerCase("pt-BR").replace(/\p{M}/gu, "");
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(tokens.filter(token => !stopwords.has(token)));
}

function rank(rows: MemoryRow[], input: string, limit: number, queryVector?: number[]): Fact[] {
  const queryWords = words(input);
  const matches = [];
  for (const row of rows) {
    const tokens = words(row.text);
    let lexical = 0;
    for (const token of queryWords) if (tokens.has(token)) lexical++;
    const vector = queryVector ? storedVector(row.embedding) : undefined;
    const cosine = queryVector && vector
      ? queryVector.reduce((sum, value, i) => sum + value * vector[i], 0)
      : 0;
    if (vector ? cosine >= minimumCosine : lexical > 0) {
      matches.push({ key: row.key, text: row.text, cosine, lexical });
    }
  }
  matches.sort((a, b) => b.cosine - a.cosine || b.lexical - a.lexical || (a.key < b.key ? -1 : 1));
  return matches.slice(0, limit).map(({ key, text }) => ({ key, text }));
}

function readMemory(sql: SqlReader): MemoryRow[] {
  return sql.exec<MemoryRow>(
    "SELECT key, text, revision, embedding FROM memory ORDER BY key LIMIT ?", capacity,
  ).toArray();
}

const retain = mutation({
  description: "Save an explicit memory fact. Reuse its key to correct the current text.",
  input: object({
    key: string({ description: "ASCII key matching [a-z0-9][a-z0-9_.-]{0,63}." }),
    text: string({ description: "Explicit fact, 1–600 characters after trimming." }),
  }),
  output: retainOutput,
}, async (ctx: WriteContext, input): Promise<RetainResult> => {
  const { key } = input;
  const text = input.text.trim();
  if (!keyPattern.test(key) || !validLength(text, 600)) {
    return { status: "invalid_input", key: null, embedding: "not_attempted" };
  }

  const saved = ctx.sql.transaction(tx => {
    const current = tx.exec<MemoryRow>("SELECT key, text, revision, embedding FROM memory WHERE key = ?", key).toArray()[0];
    if (current?.text === text) return { status: "unchanged", hasVector: current.embedding !== null } as const;
    if (current) {
      const revision = current.revision + 1;
      tx.exec("UPDATE memory SET text = ?, revision = ?, embedding = NULL WHERE key = ?", text, revision, key);
      return { status: "stored", revision } as const;
    }
    if (tx.exec<{ count: number }>("SELECT count(*) AS count FROM memory").one().count >= capacity) {
      return { status: "full" } as const;
    }
    tx.exec("INSERT INTO memory (key, text, revision) VALUES (?, ?, 1)", key, text);
    return { status: "stored", revision: 1 } as const;
  });

  const { status } = saved;
  if (status === "full") return { status, key, embedding: "not_attempted" };
  const selected = selectAccount(ctx.app.accounts.openai);
  if (!selected.account) return { status, key, embedding: selected.reason };
  if (status === "unchanged") return { status, key, embedding: saved.hasVector ? "stored" : "not_attempted" };

  const result = await embed(ctx, selected.account, text);
  if (!result.ok) return { status, key, embedding: result.reason };
  const updated = ctx.sql.exec(
    "UPDATE memory SET embedding = ? WHERE key = ? AND revision = ?",
    JSON.stringify(result.vector), key, saved.revision,
  );
  return { status, key, embedding: updated.rowsWritten > 0 ? "stored" : "superseded" };
});

const recall = query({
  description: "Find current facts using lexical matching and optional OpenAI embeddings.",
  input: object({
    query: string({ description: "Search text, 1–300 characters after trimming." }),
    limit: number({ description: "Whole number from 1 to 5. Defaults to 3." }).optional(),
  }),
  output: recallOutput,
}, async (ctx: ReadContext, input): Promise<RecallResult> => {
  const text = input.query.trim();
  const limit = input.limit ?? 3;
  if (!validLength(text, 300) || !Number.isInteger(limit) || limit < 1 || limit > 5) {
    return { status: "invalid_input", mode: "lexical", embedding: "not_attempted", results: [] };
  }

  let rows = readMemory(ctx.sql);
  const lexical = (embedding: RecallResult["embedding"]): RecallResult => ({
    status: "ok", mode: "lexical", embedding, results: rank(rows, text, limit),
  });
  const selected = selectAccount(ctx.app.accounts.openai);
  if (!selected.account) return lexical(selected.reason);
  if (!rows.some(row => storedVector(row.embedding))) return lexical("no_vectors");

  const result = await embed(ctx, selected.account, text);
  // A correction can commit while the provider is answering.
  rows = readMemory(ctx.sql);
  if (!result.ok) return lexical(result.reason);
  if (!rows.some(row => storedVector(row.embedding))) return lexical("no_vectors");
  return { status: "ok", mode: "semantic", embedding: "used", results: rank(rows, text, limit, result.vector) };
});

export default defineApp(requirements, { tools: router({ retain, recall }) });

import { bearer, defineProvider, object, ProviderError, secrets, string, type AccountRequest } from "apps";

const model = "text-embedding-3-small";
const origin = "https://api.openai.com";
const dimensions = 256;
const maxResponseBytes = 64 * 1024;
const timeoutMs = 2_500;

type FetchContext = { fetch: typeof fetch; signal: AbortSignal };
type HttpFailure = "unauthorized" | "rate_limited" | "unavailable" | "rejected";
export const providerFailures = [
  "unauthorized", "rate_limited", "unavailable", "rejected",
  "invalid_response", "network_error", "timeout", "cancelled",
] as const;
type Failure = typeof providerFailures[number];
type JsonResult = { ok: true; value: unknown } | { ok: false; reason: Failure };

class InvalidResponse extends Error {}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new InvalidResponse();
  const bytes = new Uint8Array(maxResponseBytes);
  let length = 0;
  let complete = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        complete = true;
        break;
      }
      if (chunk.value.byteLength > bytes.length - length) throw new InvalidResponse();
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    } catch {
      throw new InvalidResponse();
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

function httpFailure(status: number): HttpFailure {
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "rejected";
}

async function requestJson(ctx: FetchContext, account: AccountRequest, input?: string): Promise<JsonResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout]);
  const cancelled = (): JsonResult => ({ ok: false, reason: ctx.signal.aborted ? "cancelled" : "timeout" });

  async function request(): Promise<JsonResult> {
    try {
      const url = origin + (input === undefined ? "/v1/models/" + model : "/v1/embeddings");
      const authorization = account.headers();
      const response = await ctx.fetch(url, input === undefined
        ? { method: "GET", redirect: "manual", headers: authorization, signal }
        : {
          method: "POST",
          redirect: "manual",
          headers: { ...authorization, "content-type": "application/json" },
          body: JSON.stringify({ model, input, dimensions, encoding_format: "float" }),
          signal,
        });
      if (signal.aborted || !response.ok) {
        if (response.body) void response.body.cancel().catch(() => {});
        return signal.aborted ? cancelled() : { ok: false, reason: httpFailure(response.status) };
      }
      return { ok: true, value: await boundedJson(response, signal) };
    } catch (error) {
      if (signal.aborted) return cancelled();
      return { ok: false, reason: error instanceof InvalidResponse ? "invalid_response" : "network_error" };
    }
  }

  if (signal.aborted) return cancelled();
  // Bound the entire call, including a response body whose stream stalls.
  let onAbort: () => void = () => {};
  const aborted = new Promise<JsonResult>(resolve => {
    onAbort = () => resolve(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([request(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function normalizeVector(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== dimensions) return;
  if (!value.every(item => typeof item === "number" && Number.isFinite(item))) return;
  const max = Math.max(...value.map(item => Math.abs(item)));
  if (max === 0) return;
  const scaled = value.map(item => item / max);
  const norm = Math.hypot(...scaled);
  return scaled.map(item => item / norm);
}

export async function embed(ctx: FetchContext, account: AccountRequest, input: string) {
  const result = await requestJson(ctx, account, input);
  if (!result.ok) return result;
  const payload = asObject(result.value);
  const items = payload?.data;
  const item = Array.isArray(items) && items.length === 1 ? asObject(items[0]) : undefined;
  const vector = payload?.model === model && item?.index === 0 ? normalizeVector(item.embedding) : undefined;
  return vector ? { ok: true as const, vector } : { ok: false as const, reason: "invalid_response" as const };
}

export const openai = defineProvider({
  name: "OpenAI",
  hosts: ["api.openai.com"],
  auth: {
    apiKey: secrets({
      label: "OpenAI API key",
      fields: object({ key: string({ minLength: 1, description: "An OpenAI API key entered in Executor." }) }),
      request: ({ key }) => bearer(key),
    }),
  },
  async health(ctx) {
    const result = await requestJson(ctx, ctx.account);
    if (result.ok && asObject(result.value)?.id === model) return;
    const reason = result.ok ? "unavailable" : result.reason;
    if (reason === "unauthorized" || reason === "rate_limited" || reason === "rejected") {
      throw new ProviderError({ reason });
    }
    throw new ProviderError({ reason: "unavailable" });
  },
});

# Radar News

Radar News is a private Executor app that prepares a batch of news for a human or an agent to review. It searches for AI news, automotive news relevant to Brazil, and Apple news relevant to Brazilian consumers. It does not write a digest, publish anything, or send email.

## Install

Start with the [installation skill](SKILL.md). It covers a private deployment, secure provider setup, a read-only check, and an optional live test and schedule. The app uses a pinned Executor SDK; keep the pin rather than installing `apps@latest`.

- **Exa is required** for a live run. Link exactly one app-scoped Exa account. The app uses Exa for both search and extraction; there is no fallback provider.
- **TypeSafe Jev is optional.** Link one app-scoped Jev account to flag possible duplicates within the batch. Flags never remove entries, and the app does not compare against previously published stories.
- **The schedule is opt-in.** The declared `pre_coleta` rule runs Monday through Friday at noon in `America/Sao_Paulo` when enabled. It only saves the batch.

## Use

| Tool | Purpose |
| --- | --- |
| `collect({})` | Run one collection for the current São Paulo date. This can incur provider charges. Once the paid phase is reserved, repeating the call that day reuses the recorded attempt rather than retrying providers. |
| `latest({})` | Read the current date’s stored results without calling providers. Use `date_brt`, `run_id`, `offset`, and `limit` for a pinned, paginated read. |

The collection window ends when the run actually starts. It covers the past 24 hours, or 72 hours on Mondays. `items` contains dated candidates in the window; `undated` is separate. The search is capped at four results per topic and extraction at 12 URLs. `partial` indicates a gap; `no_news` means no eligible results in this bounded search, not that nothing happened. `previous_usable` is a reference to an older batch, not a substitution. Review source links and dates before using any result editorially. There is no automatic retention policy.

## Develop

Run these commands from `apps/radar-news` with Node.js 24 and npm:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

The tests use synthetic provider responses, the Executor SDK host, and disposable SQLite. No API keys are needed. Passing them does not establish live provider access, pricing, or schedule activation.

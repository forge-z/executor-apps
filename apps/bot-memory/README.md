# Bot Memory

Give a bot a small, persistent store for facts it should remember across sessions. Deploy one private copy per bot. Each installation has its own SQLite database, and its bot connection must be scoped to `retain` and `recall`.

See the [installation skill](SKILL.md) for deployment and verification.

| Tool | Input | Behavior |
| --- | --- | --- |
| retain | { key, text } | Stores or corrects a fact. A correction keeps the previous revision for human review. An identical repeat skips embedding and adds no revision. A forgotten key returns `forgotten` with embedding `not_attempted`. |
| recall | { query, limit? } | Returns matching current facts with the search mode. The default limit is 3, up to 5. |

Each installation holds up to 300 current keys. Facts are limited to 600 Unicode code points, queries to 300. Only explicit corrections create history, and recall searches only current facts. Do not store secrets or sensitive conversation data.

Each installation holds up to 1,000 history rows. At that limit, a correction returns `full` without changing the fact or its history. An approved `admin.forget` frees the space used by that fact’s history.

Word matching works with no API key. Optional semantic search uses OpenAI text-embedding-3-small. Link a key only in Executor’s secure account form. If enabled, fact and query text may be sent to OpenAI and incur charges; saved facts are still searchable by words when embedding is unavailable. Facts written without an embedding are not backfilled automatically.

## Human review and forget

Open the private panel through authenticated Executor to list, filter, and review facts. The panel only calls `admin.list`, which returns exact keys, text, revisions, and each fact’s previous revision numbers and text, newest first. Results are sorted by key and paged after the last key, 25 rows by default and at most 50 per request. Filtering is a literal, case-sensitive substring search on the current key or text, not the history. Each page reflects the database at read time, so concurrent writes can change later pages. The panel keeps one page of facts at a time.

1. Select **Review…** to see the exact fact text, key, current revision, and any previous revisions. Use the JSON shown there for the two `admin.forget` arguments, `key` and `expectedRevision`.
2. In the same app’s native Executor **Tools** tab, run `admin.forget` with those arguments. Executor shows the saved operation and inputs and resumes the call only after the operator approves. The tool declares `always()` approval. Executor rejects approval-required calls from custom app pages. [Tools and approvals](https://executor.sh/docs/concepts/tools-and-approvals)
3. After the approved call finishes, return to the panel and select **Refresh results** to reload the current list.

`admin.forget` deletes the current row with its text and embedding, deletes its revision history, and writes a key-only tombstone in the same transaction. A corrected row returns `stale_revision`, and a replay returns `already_forgotten`. List, forget, and a retain blocked by a tombstone make no provider calls.

Both admin operations are in the shared tools router in `apps@0.0.1-beta.143`. The app cannot distinguish a human browser from other callers at the operation level. **Before deployment or activation, exclude `admin.*` from every bot connection that can reach the app. Replace any `all` policy with an explicit selection of `retain` and `recall`, then verify actual access using the scoped client. Hold rollout if Executor cannot enforce the selection.** A private app and the review dialog do not enforce that tool boundary.

Forgetting is a logical SQLite deletion, with no restore flow. It does not purge database page remnants, backups, provider records, or copies already read. Keep migrations `0002` and `0003` and history- and tombstone-aware writers active. Builds from before `0003` ignore history, and builds from before `0002` ignore tombstones. Restoring a pre-forget snapshot can undo the fence. The fence covers only the exact key; preventing stale suggestions under different keys depends on stable Pi Bot keys and queue fencing in PR2.

## Deployment files

- `index.ts`, `package.json`
- `migrations/0001_memory.sql`, `migrations/0002_memory_tombstones.sql`, `migrations/0003_memory_history.sql`
- `src/openai.ts`, `src/admin-schema.ts`
- `ui/index.html`, `ui/main.tsx`, `ui/style.css`

## Develop

With Node.js 24 and npm, install the pinned dependencies with `npm ci --ignore-scripts`. Run `npm run check` and `npm test` from this directory. The commands type-check and compile the browser module against the pinned SDK. Tests use the Executor SDK host, disposable SQLite, and synthetic provider responses with no network or credentials. They cover upgrades from seeded `0001` and `0002`, revision history, list pagination and filtering, exact delete and rollback, stale revisions, replay, tombstone fencing, and approval-required host behavior. Verify the authenticated panel, native Tools tab approval, and bot connection scope on a disposable private hosted installation before rollout.

# Bot Memory

Give a bot a small, persistent store for facts it should remember across sessions. Deploy one private copy per bot: each installation has its own SQLite database, and access is limited by its Executor connection. Bot Memory does not read chat history or replace a bot’s existing memory provider automatically.

See the [installation skill](SKILL.md) for deployment and verification.

| Tool | Input | Behavior |
| --- | --- | --- |
| retain | { key, text } | Stores a fact, or corrects it by reusing its key. An identical repeat does not make another embedding request. |
| recall | { query, limit? } | Returns matching current facts with the search mode. The default limit is 3, up to 5. |

Each installation holds up to 300 keys. Facts are limited to 600 Unicode code points, queries to 300. There is no automatic retention or history capture. Do not store secrets or sensitive conversation data.

Word matching works with no API key. Optional semantic search uses OpenAI text-embedding-3-small. Link a key only in Executor’s secure account form. If enabled, fact and query text may be sent to OpenAI and incur charges; saved facts are still searchable by words when embedding is unavailable. Facts written without an embedding are not backfilled automatically.

## Develop

With Node.js 24 and npm, run npm ci --ignore-scripts, npm run check, and npm test from this directory. Tests use the Executor SDK host, disposable SQLite, and synthetic provider responses. No credentials are required.

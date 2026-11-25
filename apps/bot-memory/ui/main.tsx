import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createAppClient, queryReference } from "apps/client";
import type { Infer } from "apps";
import type { listMemory } from "../index.js";
import { listOutput, type ListedFact } from "../src/admin-schema.js";

const client = createAppClient();
const listRef = queryReference<typeof listMemory>("admin.list");

type PageRequest = { filter: string; cursors: string[] };
type ListResult = Infer<typeof listOutput>;

function ForgetReview({ row, onClose }: {
  row: ListedFact;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog ref={dialogRef} aria-labelledby="forget-title" aria-describedby="forget-note" onCancel={event => {
      event.preventDefault();
      onClose();
    }}>
      <h2 id="forget-title">Review fact for forgetting</h2>
      <p id="forget-note">Forgetting removes this fact and its history and blocks reuse of its key.</p>
      <dl>
        <dt>Key</dt><dd><code>{row.key}</code></dd>
        <dt>Fact text</dt><dd>{row.text}</dd>
        <dt>Revision</dt><dd>{row.revision}</dd>
      </dl>
      {row.history.length > 0 && <>
        <h3>Previous revisions</h3>
        <dl>
          {row.history.map(({ revision, text }) => (
            <div key={revision}>
              <dt>Revision {revision}</dt><dd>{text}</dd>
            </div>
          ))}
        </dl>
      </>}
      <p>In the same app’s native Executor <strong>Tools</strong> tab, run <code>admin.forget</code> with these arguments.</p>
      <pre><code>{JSON.stringify({ key: row.key, expectedRevision: row.revision }, null, 2)}</code></pre>
      <p>Review the saved call in Executor and approve it to proceed. After the call finishes, return here and select <strong>Refresh results</strong>.</p>
      <button type="button" autoFocus onClick={onClose}>Close</button>
    </dialog>
  );
}

function MemoryPanel() {
  const [filter, setFilter] = useState("");
  const [request, setRequest] = useState<PageRequest>({ filter: "", cursors: [] });
  const [snapshot, setSnapshot] = useState<{ request: PageRequest; data?: ListResult }>();
  const [selected, setSelected] = useState<ListedFact>();

  useEffect(() => {
    let active = true;
    const cursor = request.cursors.at(-1);
    void client.query(listRef, { filter: request.filter, ...(cursor === undefined ? {} : { cursor }) }, listOutput)
      .then(data => { if (active) setSnapshot({ request, data }); })
      .catch(() => { if (active) setSnapshot({ request }); });
    return () => { active = false; };
  }, [request]);

  const loading = snapshot?.request !== request;
  const page = loading ? undefined : snapshot.data;
  const nextCursor = page?.nextCursor;

  return (
    <main>
      <h1>Bot Memory</h1>
      <form onSubmit={event => {
        event.preventDefault();
        setRequest({ filter, cursors: [] });
      }}>
        <label htmlFor="filter">Filter by key or fact text</label>
        <div className="actions">
          <input id="filter" type="search" maxLength={1200} autoComplete="off" value={filter}
            onChange={event => setFilter(event.target.value)} />
          <button type="submit">Filter</button>
          <button type="button" disabled={loading} onClick={() => setRequest({ ...request })}>Refresh results</button>
        </div>
      </form>
      {loading && <p role="status">Loading facts…</p>}
      {!loading && !page && <p role="alert">Could not read facts. Select Refresh results to try again.</p>}
      {page?.status === "invalid_input" && <p role="alert">Use a filter of 600 characters or fewer.</p>}
      {page?.status === "ok" && (page.rows.length === 0 ? <p>No matching facts.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Key</th><th scope="col">Fact text</th><th scope="col">Action</th></tr></thead>
            <tbody>{page.rows.map(row => (
              <tr key={row.key}>
                <th scope="row"><code>{row.key}</code></th>
                <td className="fact">{row.text}</td>
                <td><button type="button" onClick={() => setSelected(row)}
                  aria-label={`Review fact ${row.key}`}>Review…</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      <nav className="actions" aria-label="Fact pages">
        <button type="button" disabled={loading || request.cursors.length === 0} onClick={() =>
          setRequest({ ...request, cursors: request.cursors.slice(0, -1) })}>Previous</button>
        <button type="button" disabled={!nextCursor} onClick={() => {
          if (nextCursor) setRequest({ ...request, cursors: [...request.cursors, nextCursor] });
        }}>Next</button>
      </nav>
      {selected && <ForgetReview row={selected} onClose={() => setSelected(undefined)} />}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");
createRoot(root).render(<MemoryPanel />);

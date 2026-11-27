import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { array, object, string } from "apps";
import { createAppClient, mutationReference, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type {
  addShow, addSuggestion, listEpisodes, listShows, listSuggestions,
  removeShow, removeSuggestion, setEpisodeWatched, setSuggestionStatus, updateShow,
} from "../index.js";
import { Episode, Show, Suggestion } from "../schema.js";
import "./style.css";

type ShowRow = {
  id: string; title: string; status: string;
  stoppedSeason?: number; stoppedEpisode?: number;
  releasedSeason?: number; releasedEpisode?: number;
  genre: string; platform: string; note: string;
};
type EpisodeRow = { id: string; showId: string; season: number; episode: number; watched: boolean };

const client = createAppClient();
const showsRef = queryReference<typeof listShows>("listShows");
const suggestionsRef = queryReference<typeof listSuggestions>("listSuggestions");
const episodesRef = queryReference<typeof listEpisodes>("listEpisodes");
const showsAtom = client.queryAtom(showsRef, {}, array(Show));
const suggestionsAtom = client.queryAtom(suggestionsRef, {}, array(Suggestion));
const episodesAtom = client.queryAtom(episodesRef, {}, array(Episode));
const add = client.mutation(mutationReference<typeof addShow>("addShow"), Show);
const save = client.mutation(mutationReference<typeof updateShow>("updateShow"), Show);
const Removed = object({ id: string() });
const del = client.mutation(mutationReference<typeof removeShow>("removeShow"), Removed);
const addTip = client.mutation(mutationReference<typeof addSuggestion>("addSuggestion"), Suggestion);
const tipStatus = client.mutation(mutationReference<typeof setSuggestionStatus>("setSuggestionStatus"), Suggestion);
const delTip = client.mutation(mutationReference<typeof removeSuggestion>("removeSuggestion"), Removed);
const watch = client.mutation(mutationReference<typeof setEpisodeWatched>("setEpisodeWatched"), Episode);

const labels = [
  ["assistindo", "Assistindo agora"],
  ["pendente", "Já saiu e não viu"],
  ["em_dia", "Em dia, esperando"],
  ["terminada", "Terminadas"],
];
const nav = [
  ["assistindo", "Assistindo"],
  ["pendente", "Pra ver"],
  ["em_dia", "Em dia"],
  ["terminada", "Terminadas"],
  ["dicas", "Dicas"],
];

function App() {
  const showsQuery = useAppQuery(showsAtom);
  const tipsQuery = useAppQuery(suggestionsAtom);
  const episodesQuery = useAppQuery(episodesAtom);
  const shows = (showsQuery.data || []) as ShowRow[];
  const tips = tipsQuery.data || [];
  const episodes = (episodesQuery.data || []) as EpisodeRow[];
  const [tab, setTab] = useState("assistindo");
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [failure, setFailure] = useState("");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("assistindo");
  const [season, setSeason] = useState("");
  const [episode, setEpisode] = useState("");
  const [released, setReleased] = useState("");
  const [genre, setGenre] = useState("");
  const [platform, setPlatform] = useState("");
  const [note, setNote] = useState("");
  const [newSeason, setNewSeason] = useState("1");
  const [newEpisode, setNewEpisode] = useState("1");
  const [tipTitle, setTipTitle] = useState("");
  const [tipWhy, setTipWhy] = useState("");

  const groups: Record<string, ShowRow[]> = {
    assistindo: shows.filter(s => s.status === "assistindo"),
    pendente: shows.filter(s => s.status === "pendente"),
    em_dia: shows.filter(s => s.status === "em_dia"),
    terminada: shows.filter(s => s.status === "terminada"),
  };

  function reset() {
    setEditing(null); setTitle(""); setStatus("assistindo");
    setSeason(""); setEpisode(""); setReleased("");
    setGenre(""); setPlatform(""); setNote("");
  }
  function fill(s: ShowRow) {
    setEditing(s.id); setTitle(s.title); setStatus(s.status);
    setSeason(s.stoppedSeason == null ? "" : String(s.stoppedSeason));
    setEpisode(s.stoppedEpisode == null ? "" : String(s.stoppedEpisode));
    setReleased(s.releasedSeason == null ? "" : String(s.releasedSeason));
    setGenre(s.genre); setPlatform(s.platform); setNote(s.note);
  }
  async function run(key: string, work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(key); setFailure("");
    try { await work(); }
    catch { setFailure("Não consegui salvar. Tente de novo."); }
    finally { setBusy(""); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const payload = {
      title: title.trim(), status,
      stoppedSeason: season ? Number(season) : undefined,
      stoppedEpisode: episode ? Number(episode) : undefined,
      releasedSeason: released ? Number(released) : undefined,
      genre: genre.trim(), platform: platform.trim(), note: note.trim(),
    };
    await run("show", async () => {
      if (editing) await save({ id: editing, ...payload });
      else await add({ ...payload, id: crypto.randomUUID() });
      reset();
    });
  }
  function openEpisodes(id: string) {
    setOpen(open === id ? null : id);
    setNewSeason("1"); setNewEpisode("1"); setFailure("");
  }

  const current = tab === "dicas" ? [] : groups[tab] || [];
  const problem = showsQuery.error || tipsQuery.error || episodesQuery.error;

  return (
    <main className="max-w-5xl min-h-dvh mx-auto px-5 py-8">
      <header className="flex items-baseline justify-between border-b border-[#deded7] pb-4">
        <div>
          <h1 className="text-2xl font-medium tracking-tight m-0">TV Tracker</h1>
          <p className="text-sm text-[#77776f] m-0">Onde parou, o que falta, o que vem e o que vale começar.</p>
        </div>
        <span className="text-xs text-[#77836e]">{showsQuery.pending ? "Conectando…" : problem ? "Sem conexão" : "Ao vivo"}</span>
      </header>
      {problem ? <p role="alert" className="text-sm text-[#a74636]">{problem}</p> : null}
      {failure ? <p role="alert" className="text-sm text-[#a74636]">{failure}</p> : null}

      <nav className="flex flex-wrap gap-2 my-5">
        {nav.map(([key, label]) => {
          const count = key === "dicas" ? tips.length : (groups[key] || []).length;
          return (
            <button key={key} onClick={() => setTab(key)}
              className={"rounded-full px-4 py-2 text-sm border cursor-pointer " + (tab === key ? "bg-[#2f3a31] text-white border-[#2f3a31]" : "bg-white border-[#deded7]")}>
              {label} {count}
            </button>
          );
        })}
      </nav>

      {tab === "dicas" ? (
        <section className="grid gap-3 sm:grid-cols-2">
          {tips.map(t => (
            <article key={t.id} className="bg-white border border-[#e4e4dd] rounded-xl p-4">
              <div className="flex justify-between gap-3">
                <h3 className="font-medium m-0">{t.title}</h3>
                <button onClick={() => void run("tip-" + t.id, () => delTip({ id: t.id }))} className="text-xs text-[#9a6b5b] bg-transparent border-0 cursor-pointer">remover</button>
              </div>
              <p className="text-sm text-[#56564f] my-2">{t.why}</p>
              <p className="text-xs text-[#888880] m-0">{t.platform}{t.source ? " · " + t.source : ""}</p>
              <button onClick={() => void run("tip-status-" + t.id, () => tipStatus({ id: t.id, status: t.status === "nova" ? "assistindo" : "nova" }))}
                className="mt-3 text-xs rounded-md border border-[#ccc] bg-[#fafaf8] px-3 py-1.5 cursor-pointer">
                {t.status === "nova" ? "Começar a assistir" : "Voltar pra nova"}
              </button>
            </article>
          ))}
          <form onSubmit={event => {
            event.preventDefault();
            if (!tipTitle.trim()) return;
            void run("new-tip", async () => {
              await addTip({ id: crypto.randomUUID(), title: tipTitle.trim(), why: tipWhy.trim() });
              setTipTitle(""); setTipWhy("");
            });
          }} className="bg-white border border-[#e4e4dd] rounded-xl p-4 flex flex-col gap-2">
            <input value={tipTitle} onChange={e => setTipTitle(e.target.value)} placeholder="Nova recomendação" className="border border-[#ddd] rounded-lg px-3 py-2 text-sm" />
            <textarea value={tipWhy} onChange={e => setTipWhy(e.target.value)} placeholder="Por que serve" rows={2} className="border border-[#ddd] rounded-lg px-3 py-2 text-sm" />
            <button className="self-start rounded-lg bg-[#2f3a31] text-white text-sm px-4 py-2 cursor-pointer">Adicionar dica</button>
          </form>
        </section>
      ) : (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {current.map(s => {
            const showEpisodes = episodes.filter(e => e.showId === s.id);
            return (
              <article key={s.id} className="bg-white border border-[#e4e4dd] rounded-xl p-4">
                <div className="flex justify-between gap-2">
                  <h3 className="font-medium m-0">{s.title}</h3>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => fill(s)} className="text-xs text-[#5c6d5e] bg-transparent border-0 cursor-pointer">editar</button>
                    <button onClick={() => void run("del-" + s.id, () => del({ id: s.id }))} className="text-xs text-[#9a6b5b] bg-transparent border-0 cursor-pointer">remover</button>
                  </div>
                </div>
                <p className="text-sm text-[#56564f] my-2">
                  {s.stoppedSeason == null ? "—" : "T" + s.stoppedSeason + "E" + (s.stoppedEpisode == null ? "?" : s.stoppedEpisode)}
                  {s.releasedSeason == null ? "" : " · até T" + s.releasedSeason}
                </p>
                <p className="text-xs text-[#888880] m-0">{[s.genre, s.platform].filter(Boolean).join(" · ")}</p>
                {s.note ? <p className="text-xs text-[#56564f] mt-2 mb-0">{s.note}</p> : null}
                <button onClick={() => openEpisodes(s.id)} className="mt-3 text-xs rounded-md border border-[#ccc] bg-[#fafaf8] px-3 py-1.5 cursor-pointer">
                  Episódios ({showEpisodes.filter(e => e.watched).length}/{showEpisodes.length})
                </button>
                {open === s.id ? (
                  <div className="mt-3 border-t border-[#eee] pt-3">
                    {showEpisodes.length === 0 ? <p className="text-xs text-[#888880]">Adicione o primeiro episódio abaixo.</p> : null}
                    {showEpisodes.map(e => (
                      <label key={e.id} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={e.watched}
                          disabled={busy === e.id}
                          onChange={event => void run(e.id, () => watch({
                            showId: s.id, season: e.season, episode: e.episode, watched: event.target.checked,
                          }))}
                        />
                        T{e.season}E{e.episode}
                      </label>
                    ))}
                    <div className="flex items-center gap-2 mt-3">
                      <input aria-label="Temporada" value={newSeason} onChange={e => setNewSeason(e.target.value)} inputMode="numeric" className="w-16 border border-[#ddd] rounded-md px-2 py-1 text-xs" />
                      <input aria-label="Episódio" value={newEpisode} onChange={e => setNewEpisode(e.target.value)} inputMode="numeric" className="w-16 border border-[#ddd] rounded-md px-2 py-1 text-xs" />
                      <button
                        disabled={!Number(newSeason) || !Number(newEpisode)}
                        onClick={() => void run("new-episode", async () => {
                          await watch({ showId: s.id, season: Number(newSeason), episode: Number(newEpisode), watched: false });
                          setNewEpisode(String(Number(newEpisode) + 1));
                        })}
                        className="rounded-md bg-[#2f3a31] text-white text-xs px-3 py-1.5 cursor-pointer disabled:opacity-50">
                        Adicionar episódio
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>
      )}

      <form onSubmit={e => void submit(e)} className="mt-8 bg-white border border-[#e4e4dd] rounded-xl p-4 grid gap-3 sm:grid-cols-2">
        <h2 className="sm:col-span-2 text-sm font-medium m-0">{editing ? "Editar série" : "Adicionar série"}</h2>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Nome da série" className="border border-[#ddd] rounded-lg px-3 py-2 text-sm" required />
        <select value={status} onChange={e => setStatus(e.target.value)} className="border border-[#ddd] rounded-lg px-3 py-2 text-sm bg-white">
          {labels.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input value={season} onChange={e => setSeason(e.target.value)} placeholder="Temporada atual" inputMode="numeric" className="border border-[#ddd] rounded-lg px-3 py-2 text-sm" />
        <input value={episode} onChange={e => setEpisode(e.target.value)} placeholder="Episódio atual" inputMode="numeric" className="border border-[#ddd] rounded-lg px-3 py-2 text-sm" />
        <input value={released} onChange={e => setReleased(e.target.value)} placeholder="Temporada lançada" inputMode="numeric" className="border border-[#ddd] rounded-lg px-3 py-2 text-sm" />
        <input value={genre} onChange={e => setGenre(e.target.value)} placeholder="Gênero" className="border border-[#ddd] rounded-lg px-3 py-2 text-sm" />
        <input value={platform} onChange={e => setPlatform(e.target.value)} placeholder="Plataforma" className="border border-[#ddd] rounded-lg px-3 py-2 text-sm" />
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Nota" className="sm:col-span-2 border border-[#ddd] rounded-lg px-3 py-2 text-sm" />
        <div className="sm:col-span-2 flex gap-2">
          <button className="rounded-lg bg-[#2f3a31] text-white text-sm px-4 py-2 cursor-pointer">{editing ? "Salvar" : "Adicionar"}</button>
          {editing ? <button type="button" onClick={reset} className="rounded-lg border border-[#ddd] bg-white text-sm px-4 py-2 cursor-pointer">Cancelar</button> : null}
        </div>
      </form>
      <footer className="text-xs text-[#a1a197] mt-8">TV Tracker · feito com Executor</footer>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing app root");
createRoot(root).render(<StrictMode><App /></StrictMode>);

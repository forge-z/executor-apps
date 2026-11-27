
import { query, mutation, type QueryContext, type MutationContext, array, defineApp, object, string, number, boolean, router } from "apps";
import { Show, Suggestion, Episode } from "./schema.js";

const requirements = {};
type Row = {
  id: string; title: string; status: string; stopped_season: number | null;
  stopped_episode: number | null; released_season: number | null;
  released_episode: number | null; genre: string; platform: string;
  note: string; position: number; updated_at: number;
};
type SuggestionRow = {
  id: string; title: string; why: string; platform: string; source: string;
  status: string; position: number;
};
type EpisodeRow = {
  id: string; show_id: string; season: number; episode: number; watched: number;
};

export const listShows = query(
  { input: object({}), output: array(Show) },
  async ({ sql }: QueryContext<typeof requirements>) =>
    sql.exec<Row>("SELECT * FROM shows ORDER BY position, title").toArray(),
);
export const addShow = mutation(
  { input: object({
    id: string().optional(), title: string(), status: string(),
    stoppedSeason: number().optional(), stoppedEpisode: number().optional(),
    releasedSeason: number().optional(), releasedEpisode: number().optional(),
    genre: string().optional(), platform: string().optional(), note: string().optional(),
  }), output: Show },
  async ({ sql }: MutationContext<typeof requirements>, input) =>
    sql.exec<Row>(
      "INSERT INTO shows (id,title,status,stopped_season,stopped_episode,released_season,released_episode,genre,platform,note,position,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *",
      input.id ?? crypto.randomUUID(), input.title, input.status,
      input.stoppedSeason ?? null, input.stoppedEpisode ?? null,
      input.releasedSeason ?? null, input.releasedEpisode ?? null,
      input.genre ?? "", input.platform ?? "", input.note ?? "",
      Date.now(), Date.now(),
    ).one(),
);
export const updateShow = mutation(
  { input: object({
    id: string(), title: string().optional(), status: string().optional(),
    stoppedSeason: number().optional(), stoppedEpisode: number().optional(),
    releasedSeason: number().optional(), releasedEpisode: number().optional(),
    genre: string().optional(), platform: string().optional(), note: string().optional(),
  }), output: Show },
  async ({ sql }: MutationContext<typeof requirements>, input) => {
    const current = await sql.exec<Row>("SELECT * FROM shows WHERE id = ?", input.id).one();
    const v = {
      title: input.title ?? current.title,
      status: input.status ?? current.status,
      stopped_season: input.stoppedSeason ?? current.stopped_season,
      stopped_episode: input.stoppedEpisode ?? current.stopped_episode,
      released_season: input.releasedSeason ?? current.released_season,
      released_episode: input.releasedEpisode ?? current.released_episode,
      genre: input.genre ?? current.genre,
      platform: input.platform ?? current.platform,
      note: input.note ?? current.note,
    };
    return sql.exec<Row>(
      "UPDATE shows SET title=?,status=?,stopped_season=?,stopped_episode=?,released_season=?,released_episode=?,genre=?,platform=?,note=?,updated_at=? WHERE id=? RETURNING *",
      v.title, v.status, v.stopped_season, v.stopped_episode,
      v.released_season, v.released_episode, v.genre, v.platform, v.note,
      Date.now(), input.id,
    ).one();
  },
);
export const removeShow = mutation(
  { input: object({ id: string() }), output: object({ id: string() }) },
  async ({ sql }: MutationContext<typeof requirements>, input) => {
    sql.exec("DELETE FROM episodes WHERE show_id = ?", input.id).toArray();
    sql.exec("DELETE FROM shows WHERE id = ?", input.id).toArray();
    return { id: input.id };
  },
);
export const listSuggestions = query(
  { input: object({}), output: array(Suggestion) },
  async ({ sql }: QueryContext<typeof requirements>) =>
    sql.exec<SuggestionRow>("SELECT * FROM suggestions ORDER BY position, title").toArray(),
);
export const addSuggestion = mutation(
  { input: object({ id: string().optional(), title: string(), why: string(), platform: string().optional(), source: string().optional(), status: string().optional() }), output: Suggestion },
  async ({ sql }: MutationContext<typeof requirements>, input) =>
    sql.exec<SuggestionRow>(
      "INSERT INTO suggestions (id,title,why,platform,source,status,position) VALUES (?,?,?,?,?,?,?) RETURNING *",
      input.id ?? crypto.randomUUID(), input.title, input.why,
      input.platform ?? "", input.source ?? "", input.status ?? "nova", Date.now(),
    ).one(),
);
export const setSuggestionStatus = mutation(
  { input: object({ id: string(), status: string() }), output: Suggestion },
  async ({ sql }: MutationContext<typeof requirements>, input) =>
    sql.exec<SuggestionRow>("UPDATE suggestions SET status=? WHERE id=? RETURNING *", input.status, input.id).one(),
);
export const removeSuggestion = mutation(
  { input: object({ id: string() }), output: object({ id: string() }) },
  async ({ sql }: MutationContext<typeof requirements>, input) => {
    sql.exec("DELETE FROM suggestions WHERE id = ?", input.id).toArray();
    return { id: input.id };
  },
);
export const listEpisodes = query(
  { input: object({}), output: array(Episode) },
  async ({ sql }: QueryContext<typeof requirements>) =>
    (await sql.exec<EpisodeRow>("SELECT * FROM episodes ORDER BY show_id, season, episode").toArray()).map(function(r) {
      return { id: r.id, showId: r.show_id, season: r.season, episode: r.episode, watched: r.watched === 1 };
    }),
);
export const setEpisodes = mutation(
  { input: object({ showId: string(), entries: array(object({ season: number(), episode: number(), watched: boolean() })) }), output: object({ ok: boolean() }) },
  async ({ sql }: MutationContext<typeof requirements>, input) => {
    sql.exec("DELETE FROM episodes WHERE show_id = ?", input.showId).toArray();
    for (const e of input.entries) {
      sql.exec("INSERT INTO episodes (id, show_id, season, episode, watched) VALUES (?,?,?,?,?)", crypto.randomUUID(), input.showId, e.season, e.episode, e.watched ? 1 : 0).toArray();
    }
    return { ok: true };
  },
);
export const setEpisodeWatched = mutation(
  { input: object({ showId: string(), season: number(), episode: number(), watched: boolean() }), output: Episode },
  async ({ sql }: MutationContext<typeof requirements>, input) => {
    const existing = sql.exec<EpisodeRow>(
      "SELECT * FROM episodes WHERE show_id = ? AND season = ? AND episode = ?",
      input.showId, input.season, input.episode,
    ).toArray()[0];
    const row = existing
      ? sql.exec<EpisodeRow>(
          "UPDATE episodes SET watched = ? WHERE id = ? RETURNING *",
          input.watched ? 1 : 0, existing.id,
        ).one()
      : sql.exec<EpisodeRow>(
          "INSERT INTO episodes (id, show_id, season, episode, watched) VALUES (?, ?, ?, ?, ?) RETURNING *",
          crypto.randomUUID(), input.showId, input.season, input.episode, input.watched ? 1 : 0,
        ).one();
    return { id: row.id, showId: row.show_id, season: row.season, episode: row.episode, watched: row.watched === 1 };
  },
);

export const setProgress = mutation(
  { input: object({ id: string(), stoppedSeason: number().optional(), stoppedEpisode: number().optional() }), output: object({ ok: boolean() }) },
  async ({ sql }: MutationContext<typeof requirements>, input) => {
    sql.exec("UPDATE shows SET stopped_season=?, stopped_episode=?, updated_at=? WHERE id=?", input.stoppedSeason === undefined ? null : input.stoppedSeason, input.stoppedEpisode === undefined ? null : input.stoppedEpisode, Date.now(), input.id).toArray();
    return { ok: true };
  },
);
export default defineApp(requirements, {
  tools: router({ listShows, addShow, updateShow, removeShow, listSuggestions, addSuggestion, setSuggestionStatus, removeSuggestion, listEpisodes, setEpisodes, setEpisodeWatched, setProgress }),
});


import { object, string, number, boolean } from "apps";
export const Show = object({
  id: string(), title: string(), status: string(),
  stoppedSeason: number().optional(), stoppedEpisode: number().optional(),
  releasedSeason: number().optional(), releasedEpisode: number().optional(),
  genre: string(), platform: string(), note: string(),
});
export const Suggestion = object({
  id: string(), title: string(), why: string(),
  platform: string(), source: string(), status: string(),
});
export const Episode = object({
  id: string(), showId: string(), season: number(), episode: number(), watched: boolean(),
});

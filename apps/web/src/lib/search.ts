import MiniSearch from "minisearch";
import type { Track } from "@yfitops/core";

interface Doc {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  tags: string;
}

const strip = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function buildIndex(tracks: [string, Track][]) {
  const ms = new MiniSearch<Doc>({
    fields: ["title", "artist", "album", "genre", "tags"],
    processTerm: (t) => strip(t),
    searchOptions: { boost: { title: 3, artist: 2, tags: 2 }, prefix: true, fuzzy: 0.2, combineWith: "AND" },
  });
  ms.addAll(
    tracks.map(([id, t]) => ({
      id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      genre: t.genre,
      tags: t.tags.join(" "),
    })),
  );
  return ms;
}

export function allTags(tracks: Track[]): string[] {
  const count = new Map<string, number>();
  for (const t of tracks) for (const tag of t.tags) count.set(tag, (count.get(tag) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
}

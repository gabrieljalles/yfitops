import { useDeferredValue, useMemo, useState } from "react";
import { TrackList } from "../components/TrackList";
import { libraryStore, sharedTrackId } from "../lib/library";
import { useStore } from "../lib/observable";
import { allTags, buildIndex } from "../lib/search";
import type { Track } from "@yfitops/core";

export function SearchPage({ initialTag }: { initialTag?: string }) {
  const lib = useStore(libraryStore);
  const [q, setQ] = useState("");
  const [tags, setTags] = useState<string[]>(initialTag ? [initialTag] : []);
  const query = useDeferredValue(q);

  const entries = useMemo(() => {
    const all: [string, Track][] = Object.entries(lib.tracks);
    for (const g of lib.shared) for (const [id, t] of Object.entries(g.tracks)) all.push([sharedTrackId(g.shareId, id), t]);
    return all;
  }, [lib.tracks, lib.shared]);
  const index = useMemo(() => buildIndex(entries), [entries]);
  const tagList = useMemo(() => allTags(entries.map(([, t]) => t)), [entries]);

  const results = useMemo(() => {
    const byId = new Map(entries);
    let ids = query.trim() ? index.search(query).map((r) => String(r.id)) : tags.length ? [...byId.keys()] : [];
    if (tags.length) ids = ids.filter((id) => tags.every((tag) => byId.get(id)?.tags.includes(tag)));
    if (!query.trim()) ids.sort((a, b) => byId.get(a)!.title.localeCompare(byId.get(b)!.title));
    return ids;
  }, [query, tags, index, entries]);

  const toggleTag = (t: string) => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  return (
    <div className="page">
      <input
        className="search-input"
        type="search"
        placeholder="Música, artista, álbum ou #tag"
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {tagList.length > 0 && (
        <div className="chips">
          {tagList.map((t) => (
            <button key={t} className={`chip${tags.includes(t) ? " on" : ""}`} onClick={() => toggleTag(t)}>
              #{t}
            </button>
          ))}
        </div>
      )}
      {query.trim() || tags.length ? (
        <TrackList ids={results} empty="Nada encontrado." />
      ) : (
        <p className="muted empty">Busque por qualquer coisa ou escolha tags acima.</p>
      )}
    </div>
  );
}

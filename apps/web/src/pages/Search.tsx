import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Cover } from "../components/Cover";
import { Icon } from "../components/Icon";
import { TrackList } from "../components/TrackList";
import { addSong, coverRef, searchCatalog, songTrackId } from "../lib/catalog";
import { libraryStore } from "../lib/library";
import { sessionStore } from "../lib/session";
import { useStore } from "../lib/observable";
import { playList } from "../lib/player";
import { allTags, buildIndex } from "../lib/search";
import { formatTime } from "../lib/tracks";
import { attempt } from "../lib/ui";
import type { SongInfo, Track } from "@yfitops/core";

export function SearchPage({ initialTag }: { initialTag?: string }) {
  const lib = useStore(libraryStore);
  const canSeeCatalog = Boolean(useStore(sessionStore)?.catalog);
  const [q, setQ] = useState("");
  const [tags, setTags] = useState<string[]>(initialTag ? [initialTag] : []);
  const query = useDeferredValue(q);

  const entries = useMemo((): [string, Track][] => Object.entries(lib.tracks), [lib.tracks]);
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
        <TrackList ids={results} empty={query.trim().length >= 2 ? "Nada na sua biblioteca." : "Nada encontrado."} />
      ) : (
        <p className="muted empty">Busque por qualquer coisa ou escolha tags acima.</p>
      )}
      {/* Músicas do servidor: só para quem o administrador liberou. */}
      {!tags.length && canSeeCatalog && <CatalogResults query={query} />}
    </div>
  );
}

/**
 * Músicas que outras pessoas enviaram e que você ainda não tem. Adicionar não
 * gasta espaço: a biblioteca só passa a apontar para a música do catálogo.
 */
/** Buscas já feitas nesta sessão: repetir (ou apagar uma letra) não pergunta de novo ao servidor. */
const catalogCache = new Map<string, SongInfo[]>();

function CatalogResults({ query }: { query: string }) {
  const lib = useStore(libraryStore);
  const [songs, setSongs] = useState<SongInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const text = query.trim();

  useEffect(() => {
    if (text.length < 3) return setSongs(null);
    const key = text.toLowerCase();
    const known = catalogCache.get(key);
    if (known) return setSongs(known);
    let alive = true;
    // Espera a pessoa parar de digitar: uma requisição por busca, não por letra.
    const timer = setTimeout(() => {
      searchCatalog(text).then(
        (r) => (catalogCache.set(key, r), alive && setSongs(r)),
        () => alive && setSongs(null), // offline: só a biblioteca
      );
    }, 600);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [text]);

  const missing = (songs ?? []).filter((s) => !lib.tracks[songTrackId(s.id)]);
  if (!missing.length) return null;

  const add = (s: SongInfo, play: boolean) =>
    attempt(async () => {
      setBusy(s.id);
      try {
        const { id } = await addSong(s);
        if (play) playList([id]);
      } finally {
        setBusy(null);
      }
    }, play ? undefined : "Adicionada à biblioteca");

  return (
    <section className="catalog-results">
      <h4>No yfitops</h4>
      <p className="muted small">Músicas que outras pessoas já trouxeram. Adicionar não ocupa espaço.</p>
      <ul className="tracks">
        {missing.map((s) => (
          <li key={s.id}>
            <button className="track-main" onClick={() => void add(s, true)} disabled={busy === s.id} title="Adicionar e tocar">
              <Cover cover={coverRef(s)} seed={s.title + s.artist} size={44} />
              <span className="track-text">
                <span className="track-title">{s.title}</span>
                <span className="track-sub">{[s.artist, s.album].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="track-time">{formatTime(s.duration)}</span>
            </button>
            <button className="icon-btn" title="Adicionar à biblioteca" onClick={() => void add(s, false)} disabled={busy === s.id}>
              <Icon name="plus" size={18} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

import { musicas } from "../lib/tracks";
import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { TrackList } from "../components/TrackList";
import { createPlaylist, libraryStore } from "../lib/library";
import { useStore } from "../lib/observable";
import { playList } from "../lib/player";
import { allTags } from "../lib/search";
import { attempt } from "../lib/ui";
import { navigate } from "../router";
import { GroupGrid } from "./Home";

type Tab = "musicas" | "grupos" | "tags";
type Sort = "recentes" | "titulo" | "artista";

export function LibraryPage() {
  const lib = useStore(libraryStore);
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem("libTab") as Tab) || "musicas");
  const [sort, setSort] = useState<Sort>("recentes");

  const ids = useMemo(() => {
    const e = Object.entries(lib.tracks);
    const cmp = {
      recentes: (a: (typeof e)[0], b: (typeof e)[0]) => b[1].addedAt - a[1].addedAt,
      titulo: (a: (typeof e)[0], b: (typeof e)[0]) => a[1].title.localeCompare(b[1].title),
      artista: (a: (typeof e)[0], b: (typeof e)[0]) =>
        a[1].artist.localeCompare(b[1].artist) || a[1].album.localeCompare(b[1].album) || a[1].title.localeCompare(b[1].title),
    }[sort];
    return e.sort(cmp).map(([id]) => id);
  }, [lib.tracks, sort]);

  const tags = useMemo(() => {
    const tracks = Object.values(lib.tracks);
    return allTags(tracks).map((t) => [t, tracks.filter((x) => x.tags.includes(t)).length] as const);
  }, [lib.tracks]);

  const choose = (t: Tab) => {
    setTab(t);
    sessionStorage.setItem("libTab", t);
  };

  return (
    <div className="page">
      <div className="tabs">
        {(["musicas", "grupos", "tags"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => choose(t)}>
            {{ musicas: "Músicas", grupos: "Grupos", tags: "Tags" }[t]}
          </button>
        ))}
      </div>

      {tab === "musicas" && (
        <>
          <div className="section-head">
            <span className="muted small">{musicas(ids.length)}</span>
            <div className="row">
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Ordenar">
                <option value="recentes">Adicionadas</option>
                <option value="titulo">Título</option>
                <option value="artista">Artista</option>
              </select>
              {ids.length > 0 && (
                <button className="chip ghost" onClick={() => playList(ids)}>
                  <Icon name="play" size={14} /> tocar tudo
                </button>
              )}
            </div>
          </div>
          <TrackList ids={ids} empty="Nenhuma música ainda. Vá em Enviar." />
        </>
      )}

      {tab === "grupos" && (
        <>
          <div className="section-head">
            <span />
            <button
              className="chip ghost"
              onClick={() => {
                const name = prompt("Nome do grupo");
                if (name?.trim()) void attempt(async () => navigate(`/grupo/${await createPlaylist(name.trim())}`));
              }}
            >
              <Icon name="plus" size={14} /> novo grupo
            </button>
          </div>
          <GroupGrid
            items={Object.entries(lib.playlists)
              .sort((a, b) => a[1].name.localeCompare(b[1].name))
              .map(([id, p]) => ({ key: id, name: p.name, sub: musicas(p.trackIds.length), trackIds: p.trackIds, href: `/grupo/${id}` }))}
            empty="Nenhum grupo ainda."
          />
        </>
      )}

      {tab === "tags" &&
        (tags.length ? (
          <ul className="tag-list">
            {tags.map(([t, n]) => (
              <li key={t}>
                <button onClick={() => navigate(`/buscar?tag=${encodeURIComponent(t)}`)}>
                  <span>#{t}</span>
                  <span className="muted">{n}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted empty">Adicione tags pelo menu ⋯ de cada música.</p>
        ))}
    </div>
  );
}

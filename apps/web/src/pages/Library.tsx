import { deleteTracks, musicas } from "../lib/tracks";
import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { TrackList } from "../components/TrackList";
import { createPlaylist, libraryStore } from "../lib/library";
import { useStore } from "../lib/observable";
import { playList } from "../lib/player";
import { allTags } from "../lib/search";
import { attempt, toast } from "../lib/ui";
import { navigate } from "../router";
import { GroupGrid } from "./Home";

type Tab = "musicas" | "grupos" | "tags";
type Sort = "recentes" | "titulo" | "artista";

export function LibraryPage() {
  const lib = useStore(libraryStore);
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem("libTab") as Tab) || "musicas");
  const [sort, setSort] = useState<Sort>("recentes");
  /** null = fora do modo de seleção. */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [deleting, setDeleting] = useState("");

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

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = !!selected && ids.length > 0 && ids.every((id) => selected.has(id));

  async function removeSelected() {
    if (!selected?.size) return;
    const n = selected.size;
    if (!confirm(`Excluir ${musicas(n)} da nuvem? Isso não pode ser desfeito.`)) return;
    setDeleting(`excluindo 0 de ${n}...`);
    await attempt(async () => {
      await deleteTracks([...selected], (done, total) => setDeleting(`excluindo ${done} de ${total}...`));
      toast(`${musicas(n)} ${n === 1 ? "excluída" : "excluídas"}`);
      setSelected(null);
    });
    setDeleting("");
  }

  const choose = (t: Tab) => {
    setSelected(null);
    setTab(t);
    sessionStorage.setItem("libTab", t);
  };

  return (
    <div className="page">
      <div className="tabs">
        {(["musicas", "grupos", "tags"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => choose(t)}>
            {{ musicas: "Músicas", grupos: "Playlists", tags: "Tags" }[t]}
          </button>
        ))}
      </div>

      {tab === "musicas" && (
        <>
          {selected ? (
            <div className="section-head select-bar">
              <span className="small">
                <strong>{selected.size}</strong> {selected.size === 1 ? "selecionada" : "selecionadas"}
              </span>
              <div className="row wrap">
                <button className="chip ghost" disabled={!!deleting} onClick={() => setSelected(allSelected ? new Set() : new Set(ids))}>
                  {allSelected ? "desmarcar todas" : "selecionar todas"}
                </button>
                <button className="chip danger" disabled={!selected.size || !!deleting} onClick={() => void removeSelected()}>
                  <Icon name="trash" size={14} /> {deleting || "excluir"}
                </button>
                <button className="chip ghost" disabled={!!deleting} onClick={() => setSelected(null)}>
                  cancelar
                </button>
              </div>
            </div>
          ) : (
            <div className="section-head">
              <span className="muted small">{musicas(ids.length)}</span>
              <div className="row">
                <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Ordenar">
                  <option value="recentes">Adicionadas</option>
                  <option value="titulo">Título</option>
                  <option value="artista">Artista</option>
                </select>
                {ids.length > 0 && (
                  <>
                    <button className="chip ghost" onClick={() => playList(ids)}>
                      <Icon name="play" size={14} /> tocar tudo
                    </button>
                    <button className="chip ghost" onClick={() => setSelected(new Set())}>
                      <Icon name="check" size={14} /> selecionar
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          <TrackList
            ids={ids}
            empty="Nenhuma música ainda. Vá em Enviar."
            selected={selected ?? undefined}
            onToggle={deleting ? undefined : toggle}
          />
        </>
      )}

      {tab === "grupos" && (
        <>
          <div className="section-head">
            <span />
            <button
              className="chip ghost"
              onClick={() => {
                const name = prompt("Nome da playlist");
                if (name?.trim()) void attempt(async () => navigate(`/playlist/${await createPlaylist(name.trim())}`));
              }}
            >
              <Icon name="plus" size={14} /> nova playlist
            </button>
          </div>
          <GroupGrid
            items={Object.entries(lib.playlists)
              .sort((a, b) => a[1].name.localeCompare(b[1].name))
              .map(([id, p]) => ({ key: id, name: p.name, sub: musicas(p.trackIds.length), trackIds: p.trackIds, href: `/playlist/${id}` }))}
            empty="Nenhuma playlist ainda."
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

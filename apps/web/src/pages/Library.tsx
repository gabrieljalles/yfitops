import { deleteTracks, musicas, setFavorite } from "../lib/tracks";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { TrackList } from "../components/TrackList";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { addToPlaylist, createPlaylist, favoriteIds, libraryStore } from "../lib/library";
import { useStore } from "../lib/observable";
import { playList } from "../lib/player";
import { allTags } from "../lib/search";
import { attempt, toast } from "../lib/ui";
import { navigate } from "../router";
import { GroupGrid } from "./Home";
import { SearchResults } from "./Search";

type Tab = "musicas" | "grupos" | "tags";
type Sort = "recentes" | "titulo" | "artista";

export function LibraryPage({ initialTag }: { initialTag?: string }) {
  const lib = useStore(libraryStore);
  // Busca (antes era uma aba à parte): texto e tags. Com algo buscado, a lista vira os resultados.
  const [q, setQ] = useState("");
  const [searchTags, setSearchTags] = useState<string[]>(initialTag ? [initialTag] : []);
  const query = useDeferredValue(q);
  const searching = !!query.trim() || searchTags.length > 0;
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem("libTab") as Tab) || "musicas");
  const [sort, setSort] = useState<Sort>("recentes");
  /** null = fora do modo de seleção. */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [deleting, setDeleting] = useState("");
  /** Escolhendo a playlist que recebe as selecionadas. */
  const [picking, setPicking] = useState(false);

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

  const favorites = useMemo(() => favoriteIds(lib), [lib.tracks]);

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
  /** Todas as selecionadas já são favoritas: o botão vira "desfavoritar". */
  const allFavorite = !!selected?.size && [...selected].every((id) => lib.tracks[id]?.favoriteAt);

  async function favoriteSelected() {
    if (!selected?.size) return;
    const on = !allFavorite;
    const n = selected.size;
    await attempt(
      () => setFavorite([...selected], on),
      on ? `${musicas(n)} nas favoritas` : `${musicas(n)} fora das favoritas`,
    );
    setSelected(null);
  }

  async function removeSelected() {
    if (!selected?.size) return;
    const n = selected.size;
    // Músicas do catálogo são de todos: saem só da sua biblioteca. As antigas
    // (criptografadas, só suas) são apagadas da nuvem de verdade.
    const onlyCatalog = [...selected].every((id) => lib.tracks[id]?.song);
    const ok = await confirmDialog({
      title: n === 1 ? "Tirar da biblioteca?" : `Tirar ${n} músicas da biblioteca?`,
      message: onlyCatalog
        ? `${n === 1 ? "Ela sai" : "Elas saem"} da sua biblioteca, das suas playlists e dos downloads deste aparelho. Continuam no yfitops: dá para achar na busca e adicionar de novo.`
        : `Saem da sua biblioteca e de todos os seus aparelhos. As que só você tinha são apagadas da nuvem; isso não pode ser desfeito.`,
      confirm: "tirar",
      danger: true,
    });
    if (!ok) return;
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
      <div className="library-search">
        <input
          className="search-input"
          type="search"
          placeholder="Buscar música, artista ou #tag"
          aria-label="Buscar na biblioteca"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {searchTags.length > 0 && (
          <div className="chips">
            {searchTags.map((t) => (
              <button key={t} className="chip on" title="Tirar o filtro" onClick={() => setSearchTags(searchTags.filter((x) => x !== t))}>
                #{t} <Icon name="close" size={12} />
              </button>
            ))}
          </div>
        )}
      </div>

      {searching ? (
        <SearchResults query={query} tags={searchTags} />
      ) : (
        <>
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
                    <button className="chip" disabled={!selected.size || !!deleting} onClick={() => setPicking(true)}>
                      <Icon name="plus" size={14} /> adicionar à playlist
                    </button>
                    <button className="chip" disabled={!selected.size || !!deleting} onClick={() => void favoriteSelected()}>
                      <Icon name={allFavorite ? "heart" : "heartFilled"} size={14} /> {allFavorite ? "desfavoritar" : "favoritar"}
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
                empty="Nenhuma música ainda. Vá em Descobrir."
                selected={selected ?? undefined}
                onToggle={deleting ? undefined : toggle}
              />
              {picking && selected && (
                <PlaylistPicker
                  ids={[...selected]}
                  onClose={() => setPicking(false)}
                  onDone={() => {
                    setPicking(false);
                    setSelected(null);
                  }}
                />
              )}
            </>
          )}

          {tab === "grupos" && (
            <>
              <div className="section-head">
                <span />
                <button
                  className="chip ghost"
                  onClick={async () => {
                    const name = await promptDialog({ title: "Nova playlist", input: { placeholder: "Nome da playlist" }, confirm: "criar" });
                    if (name) void attempt(async () => navigate(`/playlist/${await createPlaylist(name)}`));
                  }}
                >
                  <Icon name="plus" size={14} /> nova playlist
                </button>
              </div>
              <GroupGrid
                items={[
                  ...(favorites.length
                    ? [{ key: "favoritas", name: "Favoritas", sub: musicas(favorites.length), trackIds: favorites, href: "/favoritas" }]
                    : []),
                  ...Object.entries(lib.playlists)
                    .sort((a, b) => a[1].name.localeCompare(b[1].name))
                    .map(([id, p]) => ({ key: id, name: p.name, sub: musicas(p.trackIds.length), trackIds: p.trackIds, href: `/playlist/${id}` })),
                ]}
                empty="Nenhuma playlist ainda."
              />
            </>
          )}

          {tab === "tags" &&
            (tags.length ? (
              <ul className="tag-list">
                {tags.map(([t, n]) => (
                  <li key={t}>
                    <button onClick={() => setSearchTags([t])}>
                      <span>#{t}</span>
                      <span className="muted">{n}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted empty">Adicione tags pelo menu ⋯ de cada música.</p>
            ))}
        </>
      )}
    </div>
  );
}

/**
 * Escolhe a playlist que recebe as músicas selecionadas (ou cria uma nova com
 * elas). As que já estão na playlist não entram de novo.
 */
function PlaylistPicker({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const lib = useStore(libraryStore);
  const [busy, setBusy] = useState(false);
  const playlists = Object.entries(lib.playlists).sort((a, b) => a[1].name.localeCompare(b[1].name));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function addTo(pid: string, name: string, added: number) {
    setBusy(true);
    // `attempt` já mostra o erro; true só se deu certo.
    const ok = await attempt(async () => {
      await addToPlaylist(pid, ids);
      return true;
    });
    setBusy(false);
    if (!ok) return;
    toast(`${musicas(added)} ${added === 1 ? "adicionada" : "adicionadas"} a ${name}`);
    onDone();
  }

  async function createWith() {
    onClose();
    const name = await promptDialog({
      title: "Nova playlist",
      message: `Com ${musicas(ids.length)} ${ids.length === 1 ? "selecionada" : "selecionadas"}.`,
      input: { placeholder: "Nome da playlist" },
      confirm: "criar",
    });
    if (!name) return;
    const pid = await attempt(() => createPlaylist(name, ids), `Playlist ${name} criada`);
    if (pid) onDone();
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="pick-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="pick-title">Adicionar {musicas(ids.length)} à playlist</h3>
        <ul className="pick-list">
          {playlists.map(([pid, p]) => {
            const inside = new Set(p.trackIds);
            const added = ids.filter((id) => !inside.has(id)).length;
            return (
              <li key={pid}>
                <button disabled={busy || added === 0} onClick={() => void addTo(pid, p.name, added)}>
                  <span className="pick-name">{p.name}</span>
                  <span className="muted small">
                    {added === 0 ? (
                      <>
                        <Icon name="check" size={12} /> já tem todas
                      </>
                    ) : added < ids.length ? (
                      `+${added} (${ids.length - added} já estão)`
                    ) : (
                      musicas(p.trackIds.length)
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            <button disabled={busy} onClick={() => void createWith()}>
              <span className="pick-name">
                <Icon name="plus" size={14} /> nova playlist
              </span>
            </button>
          </li>
        </ul>
        <div className="dialog-actions">
          <button className="chip ghost" onClick={onClose}>
            cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

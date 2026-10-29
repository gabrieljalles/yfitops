import { useMemo } from "react";
import type { BlobRef } from "@yfitops/core";
import { musicas } from "../lib/tracks";
import { Cover, Crate } from "../components/Cover";
import { Icon } from "../components/Icon";
import { promptDialog } from "../lib/dialog";
import { createPlaylist, favoriteIds, forgottenIds, getTrackFrom, libraryStore, mostPlayedIds, recentTrackIds } from "../lib/library";
import { useStore } from "../lib/observable";
import { playList } from "../lib/player";
import { attempt } from "../lib/ui";
import { useDragScroll } from "../lib/dragScroll";
import { navigate } from "../router";

export function HomePage() {
  const lib = useStore(libraryStore);
  const recent = recentTrackIds(lib, 20);
  const favorites = useMemo(() => favoriteIds(lib), [lib.tracks]);
  const mostPlayed = useMemo(() => mostPlayedIds(lib), [lib.plays, lib.tracks]);
  const forgotten = useMemo(() => forgottenIds(lib), [lib.plays, lib.tracks]);
  const groups = Object.entries(lib.playlists).sort((a, b) => b[1].createdAt - a[1].createdAt);
  const total = Object.keys(lib.tracks).length;

  if (lib.loaded && total === 0) {
    return (
      <div className="page welcome">
        <h1>Sua estante está vazia</h1>
        <p className="muted">Peça músicas pelo nome ou por um link, ou veja as que estão em alta, em Descobrir.</p>
        <button className="primary" onClick={() => navigate("/descobrir")}>
          <Icon name="compass" size={18} /> Descobrir músicas
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <Shelf title="Tocadas recentemente" ids={recent} empty="O que você ouvir aparece aqui." />

      <Shelf
        title="Favoritas"
        ids={favorites.slice(0, 20)}
        empty="Toque no coração de uma música para ela aparecer aqui."
        action={
          favorites.length > 0 && (
            <button className="link" onClick={() => navigate("/favoritas")}>
              ver todas ({favorites.length})
            </button>
          )
        }
      />

      {mostPlayed.length > 0 && <Shelf title="Mais tocadas" ids={mostPlayed} />}

      {forgotten.length > 0 && <Shelf title="Esquecidas" sub="Faz tempo que você não ouve estas" ids={forgotten} />}

      <section>
        <div className="section-head">
          <h2>Playlists</h2>
          <button
            className="chip ghost"
            onClick={async () => {
              const name = await promptDialog({ title: "Nova playlist", input: { placeholder: "Nome da playlist" }, confirm: "criar" });
              if (name) void attempt(async () => navigate(`/playlist/${await createPlaylist(name)}`));
            }}
          >
            <Icon name="plus" size={14} /> novo
          </button>
        </div>
        <GroupGrid
          items={[
            // Playlist automática das favoritas, sempre primeiro.
            ...(favorites.length
              ? [{ key: "favoritas", name: "Favoritas", sub: musicas(favorites.length), trackIds: favorites, href: "/favoritas" }]
              : []),
            ...groups.map(([id, p]) => ({ key: id, name: p.name, sub: musicas(p.trackIds.length), trackIds: p.trackIds, href: `/playlist/${id}` })),
          ]}
          empty="Crie playlists para juntar músicas do jeito que quiser. Ao importar uma playlist, ela aparece aqui sozinha."
        />
      </section>

    </div>
  );
}

export function GroupGrid({
  items,
  empty,
}: {
  items: { key: string; name: string; sub: string; trackIds: string[]; href: string }[];
  empty?: string;
}) {
  const lib = useStore(libraryStore);
  if (!items.length) return <p className="muted empty">{empty}</p>;
  return (
    <div className="grid">
      {items.map((g) => {
        // Até 3 capas diferentes (a mesma capa repetida não forma pilha).
        const covers: BlobRef[] = [];
        for (const id of g.trackIds) {
          const c = getTrackFrom(lib, id)?.cover;
          if (c && !covers.some((x) => x.id === c.id) && covers.push(c) === 3) break;
        }
        return (
          <button key={g.key} className="grid-item" onClick={() => navigate(g.href)}>
            <Crate covers={covers} seed={g.name} />
            <span className="track-title">{g.name}</span>
            <span className="track-sub">{g.sub}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Prateleira horizontal de músicas (arrasta com o mouse; toca a partir da escolhida). */
function Shelf({
  title,
  sub,
  ids,
  empty,
  action,
}: {
  title: string;
  sub?: string;
  ids: string[];
  empty?: string;
  action?: React.ReactNode;
}) {
  const lib = useStore(libraryStore);
  const drag = useDragScroll<HTMLDivElement>();
  return (
    <section>
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          {sub && <p className="muted small">{sub}</p>}
        </div>
        {action}
      </div>
      {ids.length ? (
        <div className="shelf" {...drag}>
          {ids.map((id, i) => {
            const t = getTrackFrom(lib, id);
            return (
              t && (
                <button key={id} className="shelf-item" onClick={() => playList(ids, i)}>
                  <Cover cover={t.cover} seed={t.title + t.artist} sleeve />
                  <span className="track-title">{t.title}</span>
                  <span className="track-sub">{t.artist}</span>
                </button>
              )
            );
          })}
        </div>
      ) : (
        empty && <p className="muted empty">{empty}</p>
      )}
    </section>
  );
}

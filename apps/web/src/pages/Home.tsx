import { musicas } from "../lib/tracks";
import { Cover } from "../components/Cover";
import { Icon } from "../components/Icon";
import { SyncButton } from "../components/SyncButton";
import { createPlaylist, getTrackFrom, libraryStore, recentTrackIds } from "../lib/library";
import { useStore } from "../lib/observable";
import { playList } from "../lib/player";
import { attempt } from "../lib/ui";
import { useDragScroll } from "../lib/dragScroll";
import { navigate } from "../router";

export function HomePage() {
  const lib = useStore(libraryStore);
  const shelf = useDragScroll<HTMLDivElement>();
  const recent = recentTrackIds(lib, 20);
  const groups = Object.entries(lib.playlists).sort((a, b) => b[1].createdAt - a[1].createdAt);
  const total = Object.keys(lib.tracks).length;

  if (lib.loaded && total === 0 && !lib.shared.length) {
    return (
      <div className="page welcome">
        <h1>Sua estante está vazia</h1>
        <p className="muted">Envie suas músicas. Elas são criptografadas no seu aparelho antes de subir para a nuvem.</p>
        <button className="primary" onClick={() => navigate("/enviar")}>
          <Icon name="upload" size={18} /> Enviar músicas
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <section>
        <div className="section-head">
          <h2>Tocadas recentemente</h2>
          <SyncButton />
        </div>
        {recent.length ? (
          <div className="shelf" {...shelf}>
            {recent.map((id, i) => {
              const t = getTrackFrom(lib, id)!;
              return (
                <button key={id} className="shelf-item" onClick={() => playList(recent, i)}>
                  <Cover cover={t.cover} seed={t.title + t.artist} />
                  <span className="track-title">{t.title}</span>
                  <span className="track-sub">{t.artist}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="muted empty">O que você ouvir aparece aqui.</p>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>Playlists</h2>
          <button
            className="chip ghost"
            onClick={() => {
              const name = prompt("Nome da playlist");
              if (name?.trim()) void attempt(async () => navigate(`/playlist/${await createPlaylist(name.trim())}`));
            }}
          >
            <Icon name="plus" size={14} /> novo
          </button>
        </div>
        <GroupGrid
          items={groups.map(([id, p]) => ({ key: id, name: p.name, sub: musicas(p.trackIds.length), trackIds: p.trackIds, href: `/playlist/${id}` }))}
          empty="Crie playlists para juntar músicas do jeito que quiser. Ao importar uma playlist, ela aparece aqui sozinha."
        />
      </section>

      {lib.shared.length > 0 && (
        <section>
          <h2>Compartilhados com você</h2>
          <GroupGrid
            items={lib.shared.map((g) => ({
              key: g.shareId,
              name: g.playlist.name,
              sub: `de ${g.fromEmail}`,
              trackIds: g.playlist.trackIds.map((t) => `s~${g.shareId}~${t}`),
              href: `/compartilhado/${g.shareId}`,
            }))}
          />
        </section>
      )}
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
        const first = g.trackIds.map((id) => getTrackFrom(lib, id)).find((t) => t?.cover);
        return (
          <button key={g.key} className="grid-item" onClick={() => navigate(g.href)}>
            <Cover cover={first?.cover} seed={g.name} />
            <span className="track-title">{g.name}</span>
            <span className="track-sub">{g.sub}</span>
          </button>
        );
      })}
    </div>
  );
}

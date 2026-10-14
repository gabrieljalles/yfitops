import { musicas } from "../lib/tracks";
import { useState } from "react";
import { Cover } from "../components/Cover";
import { DownloadMenu } from "../components/DownloadMenu";
import { Icon } from "../components/Icon";
import { TrackList } from "../components/TrackList";
import { deleteItem, favoriteIds, getTrackFrom, libraryStore, removeFromPlaylist, saveItem, sharePlaylist, sharedTrackId, unshare } from "../lib/library";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { linkImportStore, syncPlaylist } from "../lib/linkImport";
import { useStore } from "../lib/observable";
import { playlistSyncUrl } from "../lib/resolver";
import { playList, toggleShuffle, playerStore } from "../lib/player";
import { attempt, toast } from "../lib/ui";
import { navigate } from "../router";

function GroupHeader({ name, sub, ids, children }: { name: string; sub: string; ids: string[]; children?: React.ReactNode }) {
  const lib = useStore(libraryStore);
  const first = ids.map((id) => getTrackFrom(lib, id)).find((t) => t?.cover);

  const shufflePlay = () => {
    if (!playerStore.get().shuffle) toggleShuffle();
    playList(ids, Math.floor(Math.random() * ids.length));
  };

  return (
    <header className="group-head">
      <Cover cover={first?.cover} seed={name} className="group-cover" />
      <div className="group-info">
        <h1>{name}</h1>
        <p className="muted">{sub}</p>
        <div className="row wrap">
          <button className="primary" disabled={!ids.length} onClick={() => playList(ids)}>
            <Icon name="play" size={16} /> Tocar
          </button>
          <button className="chip ghost" disabled={!ids.length} onClick={shufflePlay}>
            <Icon name="shuffle" size={14} /> aleatório
          </button>
          <DownloadMenu ids={ids} className="chip ghost" />
          {children}
        </div>
      </div>
    </header>
  );
}

export function GroupPage({ id }: { id: string }) {
  const lib = useStore(libraryStore);
  const p = lib.playlists[id];
  const [editing, setEditing] = useState(false);
  const importing = useStore(linkImportStore);
  if (!p) return <div className="page muted">Playlist não encontrada.</div>;
  const syncUrl = playlistSyncUrl(p);
  const sentTo = lib.sent.filter((s) => s.shareId.startsWith(`${id}.`));

  return (
    <div className="page">
      <GroupHeader name={p.name} sub={musicas(p.trackIds.length)} ids={p.trackIds}>
        <button
          className="chip ghost"
          onClick={async () => {
            const email = await promptDialog({
              title: "Compartilhar playlist",
              message: "E-mail de quem vai receber a playlist (a pessoa precisa ter conta).",
              input: { type: "email", placeholder: "email@exemplo.com" },
              confirm: "compartilhar",
            });
            if (email) void attempt(() => sharePlaylist(id, email), "Playlist compartilhada");
          }}
        >
          <Icon name="share" size={14} /> compartilhar
        </button>
        {syncUrl && (
          <button
            className="chip ghost"
            disabled={importing.busy}
            title={`Baixa só as músicas novas de ${syncUrl}`}
            onClick={() => void syncPlaylist(id)}
          >
            <Icon name="sync" size={14} /> {importing.syncing === id ? "sincronizando…" : "sincronizar"}
          </button>
        )}
        <button className={`chip ghost${editing ? " on" : ""}`} onClick={() => setEditing(!editing)}>
          {editing ? "pronto" : "editar"}
        </button>
      </GroupHeader>

      {syncUrl && (
        <p className="muted small sync-note">
          {importing.syncing === id
            ? importing.note || "lendo a playlist de origem…"
            : importing.busy
              ? "Espere a importação em andamento terminar para sincronizar."
              : p.syncedAt
                ? `Importada de ${serviceOf(syncUrl)} · sincronizada ${sinceText(p.syncedAt)}`
                : `Importada de ${serviceOf(syncUrl)}`}
        </p>
      )}

      {editing && (
        <div className="row wrap edit-bar">
          <button
            className="link"
            onClick={async () => {
              const name = await promptDialog({ title: "Renomear playlist", input: { value: p.name }, confirm: "salvar" });
              if (name) void attempt(() => saveItem("playlist", id, { ...p, name }));
            }}
          >
            Renomear
          </button>
          <button
            className="link danger"
            onClick={async () => {
              const ok = await confirmDialog({
                title: "Apagar playlist?",
                message: `"${p.name}" será apagada. As músicas continuam na biblioteca.`,
                confirm: "apagar",
                danger: true,
              });
              if (ok) {
                navigate("/biblioteca");
                void attempt(() => deleteItem("playlist", id), "Playlist apagada");
              }
            }}
          >
            Apagar playlist
          </button>
        </div>
      )}

      {sentTo.length > 0 && (
        <div className="shared-with muted small">
          Compartilhado com{" "}
          {sentTo.map((s) => (
            <span key={s.shareId} className="chip small">
              {s.toEmail}
              <button title="Parar de compartilhar" onClick={() => attempt(() => unshare(s.shareId), "Compartilhamento removido")}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
          <button
            className="link"
            title="Envia a versão atual da playlist"
            onClick={() => attempt(async () => {
              for (const s of sentTo) await sharePlaylist(id, s.toEmail);
            }, "Compartilhamento atualizado")}
          >
            atualizar
          </button>
        </div>
      )}

      <TrackList
        ids={p.trackIds}
        empty="Playlist vazia. Adicione músicas pelo menu ⋯ de cada uma."
        onRemove={editing ? (tid) => void removeFromPlaylist(id, tid) : undefined}
      />
    </div>
  );
}

export function SharedGroupPage({ shareId }: { shareId: string }) {
  const lib = useStore(libraryStore);
  const g = lib.shared.find((s) => s.shareId === shareId);
  if (!g) return <div className="page muted">Compartilhamento não encontrado.</div>;
  const ids = g.playlist.trackIds.map((t) => sharedTrackId(shareId, t));
  return (
    <div className="page">
      <GroupHeader name={g.playlist.name} sub={`${musicas(ids.length)} · de ${g.fromEmail}`} ids={ids}>
        <button
          className="chip ghost"
          onClick={async () => {
            const ok = await confirmDialog({
              title: "Sair da playlist?",
              message: `Você deixa de ver "${g.playlist.name}". Quem compartilhou pode te mandar de novo.`,
              confirm: "sair",
              danger: true,
            });
            if (ok) {
              navigate("/");
              void attempt(() => unshare(shareId)).then(() => toast("Você saiu da playlist"));
            }
          }}
        >
          sair
        </button>
      </GroupHeader>
      <TrackList ids={ids} />
    </div>
  );
}

/** Playlist automática com as favoritas (o coração), da mais recente para a mais antiga. */
export function FavoritesPage() {
  const lib = useStore(libraryStore);
  const ids = favoriteIds(lib);
  return (
    <div className="page">
      <GroupHeader name="Favoritas" sub={`${musicas(ids.length)} · atualizada sozinha`} ids={ids} />
      <TrackList ids={ids} empty="Nenhuma favorita ainda. Toque no coração de uma música para ela aparecer aqui." />
    </div>
  );
}

const serviceOf = (url: string) =>
  /spotify/i.test(url) ? "Spotify" : /deezer/i.test(url) ? "Deezer" : "YouTube";

/** "agora há pouco", "há 3 horas", "há 2 dias". */
function sinceText(at: number): string {
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 2) return "agora há pouco";
  if (min < 60) return `há ${min} minutos`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} ${h === 1 ? "hora" : "horas"}`;
  const d = Math.round(h / 24);
  return `há ${d} ${d === 1 ? "dia" : "dias"}`;
}

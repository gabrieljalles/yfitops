import { musicas } from "../lib/tracks";
import { useState } from "react";
import { Cover } from "../components/Cover";
import { DownloadMenu } from "../components/DownloadMenu";
import { Icon } from "../components/Icon";
import { TrackList } from "../components/TrackList";
import { deleteItem, getTrackFrom, libraryStore, removeFromPlaylist, saveItem, sharePlaylist, sharedTrackId, unshare } from "../lib/library";
import { useStore } from "../lib/observable";
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
  if (!p) return <div className="page muted">Grupo não encontrado.</div>;
  const sentTo = lib.sent.filter((s) => s.shareId.startsWith(`${id}.`));

  return (
    <div className="page">
      <GroupHeader name={p.name} sub={musicas(p.trackIds.length)} ids={p.trackIds}>
        <button
          className="chip ghost"
          onClick={() => {
            const email = prompt("E-mail de quem vai receber o grupo (precisa ter conta):");
            if (email?.trim()) void attempt(() => sharePlaylist(id, email.trim()), "Grupo compartilhado");
          }}
        >
          <Icon name="share" size={14} /> compartilhar
        </button>
        <button className={`chip ghost${editing ? " on" : ""}`} onClick={() => setEditing(!editing)}>
          {editing ? "pronto" : "editar"}
        </button>
      </GroupHeader>

      {editing && (
        <div className="row wrap edit-bar">
          <button
            className="link"
            onClick={() => {
              const name = prompt("Novo nome", p.name);
              if (name?.trim()) void attempt(() => saveItem("playlist", id, { ...p, name: name.trim() }));
            }}
          >
            Renomear
          </button>
          <button
            className="link danger"
            onClick={() => {
              if (confirm(`Apagar o grupo "${p.name}"? As músicas continuam na biblioteca.`)) {
                navigate("/biblioteca");
                void attempt(() => deleteItem("playlist", id), "Grupo apagado");
              }
            }}
          >
            Apagar grupo
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
            title="Envia a versão atual do grupo"
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
        empty="Grupo vazio. Adicione músicas pelo menu ⋯ de cada uma."
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
          onClick={() => {
            if (confirm("Sair deste grupo compartilhado?")) {
              navigate("/");
              void attempt(() => unshare(shareId)).then(() => toast("Você saiu do grupo"));
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

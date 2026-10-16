import { useEffect, useRef, useState } from "react";
import type { Track } from "@yfitops/core";
import { addToPlaylist, createPlaylist, getTrackFrom, libraryStore } from "../lib/library";
import { useStore } from "../lib/observable";
import { addToQueue, playNext } from "../lib/player";
import { deleteTrack, formatBytes, formatTime, removeCover, setCover, updateTrack } from "../lib/tracks";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { attempt, closeTrack, toast, uiStore } from "../lib/ui";
import { Cover } from "./Cover";
import { DownloadMenu } from "./DownloadMenu";
import { FavoriteButton } from "./FavoriteButton";
import { Icon } from "./Icon";
import { LOCAL_NOTE, WithLocalBadge } from "./LocalBadge";
import { TagInput } from "./TagInput";

export function TrackSheet() {
  const { editing } = useStore(uiStore);
  const lib = useStore(libraryStore);
  const t = editing ? getTrackFrom(lib, editing) : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeTrack();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!editing || !t) return null;
  return (
    <div className="sheet-backdrop" onClick={closeTrack}>
      <div className="sheet" role="dialog" aria-label={t.title} onClick={(e) => e.stopPropagation()}>
        <Editor key={editing} id={editing} track={t} shared={editing.startsWith("s~")} />
      </div>
    </div>
  );
}

function Editor({ id, track, shared }: { id: string; track: Track; shared: boolean }) {
  const lib = useStore(libraryStore);
  const [form, setForm] = useState({ title: track.title, artist: track.artist, album: track.album, genre: track.genre });
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = (Object.keys(form) as (keyof typeof form)[]).some((k) => form[k] !== track[k]);

  const saveTags = (tags: string[]) => attempt(() => updateTrack(id, { tags }));

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    await attempt(fn, ok);
    setBusy(false);
  };

  const groups = Object.entries(lib.playlists).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const sizes = Object.entries(track.variants)
    .map(([k, v]) => `${k === "orig" ? "original" : k.toUpperCase()} ${formatBytes(v!.size)}`)
    .join(" · ");

  return (
    <>
      <header className="sheet-head">
        {/* Só deste aparelho: trocar a capa mandaria a imagem para o servidor. */}
        <button className="cover-edit" disabled={shared || track.local} onClick={() => fileInput.current?.click()} title="Trocar capa">
          <WithLocalBadge local={track.local}>
            <Cover cover={track.cover} seed={track.title + track.artist} size={96} />
          </WithLocalBadge>
          {!shared && !track.local && <span className="cover-hint">trocar capa</span>}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void run(() => setCover(id, f), "Capa atualizada");
            e.target.value = "";
          }}
        />
        <div className="sheet-title">
          <strong>{track.title}</strong>
          <span className="muted">{track.artist || "Artista desconhecido"}</span>
          <span className="muted small">
            {formatTime(track.duration)} · {track.sourceInfo}
          </span>
          <span className="muted small">{sizes}</span>
          {track.local && <span className="local-note">{LOCAL_NOTE}</span>}
        </div>
        <FavoriteButton id={id} />
        <button className="icon-btn" onClick={closeTrack} title="Fechar">
          <Icon name="close" />
        </button>
      </header>

      <div className="sheet-actions">
        <button onClick={() => (playNext(id), toast("Toca em seguida"), closeTrack())}>Tocar em seguida</button>
        <button onClick={() => (addToQueue([id]), toast("Adicionada à fila"))}>Adicionar à fila</button>
        {!track.local && <DownloadMenu ids={[id]} className="dl-trigger" />}
      </div>

      {!shared && (
        <>
          <section>
            <h4>Playlists</h4>
            <div className="chips">
              {groups.map(([pid, p]) => {
                const inside = p.trackIds.includes(id);
                return (
                  <button key={pid} className={`chip${inside ? " on" : ""}`} disabled={inside} onClick={() => attempt(() => addToPlaylist(pid, [id]), `Adicionada a ${p.name}`)}>
                    {inside && <Icon name="check" size={14} />} {p.name}
                  </button>
                );
              })}
              <button
                className="chip ghost"
                onClick={async () => {
                  const name = await promptDialog({ title: "Nova playlist", input: { placeholder: "Nome da playlist" }, confirm: "criar" });
                  if (name) void attempt(() => createPlaylist(name, [id]), `Playlist ${name} criada`);
                }}
              >
                <Icon name="plus" size={14} /> nova playlist
              </button>
            </div>
          </section>

          <section>
            <h4>Tags</h4>
            <TagInput tags={track.tags} onChange={(tags) => void saveTags(tags)} />
          </section>

          <section>
            <h4>Informações</h4>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => updateTrack(id, { ...form, title: form.title.trim() || track.title }), "Salvo");
              }}
            >
              {(
                [
                  ["title", "Título"],
                  ["artist", "Artista"],
                  ["album", "Álbum"],
                  ["genre", "Gênero"],
                ] as const
              ).map(([k, label]) => (
                <label key={k}>
                  <span>{label}</span>
                  <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                </label>
              ))}
              {dirty && (
                <button className="primary" disabled={busy}>
                  Salvar
                </button>
              )}
            </form>
          </section>

          <footer className="sheet-foot">
            {track.cover && (
              <button className="link" onClick={() => run(() => removeCover(id), "Capa removida")}>
                Usar capa de vinil
              </button>
            )}
            <button
              className="link danger"
              onClick={async () => {
                // Música do catálogo é de todos: sai só da sua biblioteca (e dos seus downloads).
                const ok = await confirmDialog(
                  track.local
                    ? {
                        title: "Excluir música?",
                        message: `"${track.title}" só existe neste celular (não foi para o servidor). Excluir apaga de vez: não dá para recuperar.`,
                        confirm: "excluir",
                        danger: true,
                      }
                    : track.song
                    ? {
                        title: "Tirar da biblioteca?",
                        message: `"${track.title}" sai da sua biblioteca, das suas playlists e dos downloads deste aparelho. Para ter de novo, é só trazer outra vez.`,
                        confirm: "tirar",
                        danger: true,
                      }
                    : {
                        title: "Excluir música?",
                        message: `"${track.title}" será apagada da nuvem e de todos os aparelhos. Isso não pode ser desfeito.`,
                        confirm: "excluir",
                        danger: true,
                      },
                );
                if (ok) {
                  closeTrack();
                  void attempt(() => deleteTrack(id), track.song ? "Tirada da biblioteca" : "Música excluída");
                }
              }}
            >
              Excluir música
            </button>
          </footer>
        </>
      )}
    </>
  );
}

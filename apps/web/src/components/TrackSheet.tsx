import { useEffect, useRef, useState } from "react";
import type { Track } from "@yfitops/core";
import { addToPlaylist, createPlaylist, getTrackFrom, libraryStore } from "../lib/library";
import { useStore } from "../lib/observable";
import { addToQueue, playNext } from "../lib/player";
import { allTags, normalizeTag } from "../lib/search";
import { deleteTrack, formatBytes, formatTime, removeCover, setCover, updateTrack } from "../lib/tracks";
import { attempt, closeTrack, toast, uiStore } from "../lib/ui";
import { Cover } from "./Cover";
import { DownloadMenu } from "./DownloadMenu";
import { Icon } from "./Icon";

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
  const [tagInput, setTagInput] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = (Object.keys(form) as (keyof typeof form)[]).some((k) => form[k] !== track[k]);
  const suggestions = allTags(Object.values(lib.tracks)).filter((t) => !track.tags.includes(t) && t.startsWith(normalizeTag(tagInput))).slice(0, 6);

  const saveTags = (tags: string[]) => attempt(() => updateTrack(id, { tags }));
  const addTag = (raw: string) => {
    const tags = raw.split(",").map(normalizeTag).filter((t) => t && !track.tags.includes(t));
    if (tags.length) void saveTags([...track.tags, ...tags]);
    setTagInput("");
  };

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
        <button className="cover-edit" disabled={shared} onClick={() => fileInput.current?.click()} title="Trocar capa">
          <Cover cover={track.cover} seed={track.title + track.artist} size={96} />
          {!shared && <span className="cover-hint">trocar capa</span>}
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
        </div>
        <button className="icon-btn" onClick={closeTrack} title="Fechar">
          <Icon name="close" />
        </button>
      </header>

      <div className="sheet-actions">
        <button onClick={() => (playNext(id), toast("Toca em seguida"), closeTrack())}>Tocar em seguida</button>
        <button onClick={() => (addToQueue([id]), toast("Adicionada à fila"))}>Adicionar à fila</button>
        <DownloadMenu ids={[id]} className="dl-trigger" />
      </div>

      {!shared && (
        <>
          <section>
            <h4>Grupos</h4>
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
                onClick={() => {
                  const name = prompt("Nome do novo grupo");
                  if (name?.trim()) void attempt(() => createPlaylist(name.trim(), [id]), `Grupo ${name.trim()} criado`);
                }}
              >
                <Icon name="plus" size={14} /> novo grupo
              </button>
            </div>
          </section>

          <section>
            <h4>Tags</h4>
            <div className="chips">
              {track.tags.map((tag) => (
                <button key={tag} className="chip on" title="Remover tag" onClick={() => saveTags(track.tags.filter((x) => x !== tag))}>
                  #{tag} <Icon name="close" size={12} />
                </button>
              ))}
              <input
                className="chip-input"
                placeholder="adicionar tag…"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag(tagInput);
                  }
                }}
                onBlur={() => tagInput && addTag(tagInput)}
              />
            </div>
            {suggestions.length > 0 && (
              <div className="chips suggestions">
                {suggestions.map((s) => (
                  <button key={s} className="chip ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => addTag(s)}>
                    #{s}
                  </button>
                ))}
              </div>
            )}
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
              onClick={() => {
                if (confirm(`Excluir "${track.title}" da nuvem? Isso não pode ser desfeito.`)) {
                  closeTrack();
                  void attempt(() => deleteTrack(id), "Música excluída");
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

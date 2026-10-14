import { isOffline, offlineStore } from "../lib/blobs";
import { getTrackFrom, libraryStore } from "../lib/library";
import { useStore } from "../lib/observable";
import { playerStore, playList } from "../lib/player";
import { formatTime } from "../lib/tracks";
import { openTrack } from "../lib/ui";
import { Cover } from "./Cover";
import { Icon } from "./Icon";

export function TrackList({
  ids,
  empty = "Nada por aqui ainda.",
  onRemove,
  selected,
  onToggle,
}: {
  ids: string[];
  empty?: string;
  /** Mostra um botão para tirar a música da lista (ex.: dentro de uma playlist). */
  onRemove?: (id: string) => void;
  /** Modo de seleção: tocar numa linha marca/desmarca em vez de tocar a música. */
  selected?: Set<string>;
  onToggle?: (id: string) => void;
}) {
  const selecting = !!selected && !!onToggle;
  const lib = useStore(libraryStore);
  const player = useStore(playerStore);
  const offline = useStore(offlineStore);
  const current = player.queue[player.index];
  const rows = ids.map((id) => [id, getTrackFrom(lib, id)] as const).filter(([, t]) => t);

  if (!rows.length) return <p className="muted empty">{empty}</p>;

  return (
    <ul className="tracks">
      {rows.map(([id, t], i) => {
        const downloaded = Object.values(t!.variants).some((v) => isOffline(offline, v));
        return (
          <li key={id} className={`${id === current ? "active" : ""}${selected?.has(id) ? " selected" : ""}`}>
            <button
              className="track-main"
              onClick={() => (selecting ? onToggle(id) : playList(rows.map(([x]) => x), i))}
              aria-pressed={selecting ? selected.has(id) : undefined}
            >
              {selecting && (
                <span className={`check-box${selected.has(id) ? " on" : ""}`} aria-hidden="true">
                  {selected.has(id) && <Icon name="check" size={14} />}
                </span>
              )}
              <Cover cover={t!.cover} seed={t!.title + t!.artist} size={44} />
              <span className="track-text">
                <span className="track-title">{t!.title}</span>
                <span className="track-sub">
                  {downloaded && (
                    <span className="badge" title="Disponível offline">
                      <Icon name="download" size={12} />
                    </span>
                  )}
                  {[t!.artist, t!.album].filter(Boolean).join(" · ") || "Artista desconhecido"}
                </span>
              </span>
              <span className="track-time">{formatTime(t!.duration)}</span>
            </button>
            {selecting ? null : onRemove ? (
              <button className="icon-btn" title="Tirar da playlist" onClick={() => onRemove(id)}>
                <Icon name="close" size={18} />
              </button>
            ) : (
              <button className="icon-btn" title="Mais opções" onClick={() => openTrack(id)}>
                <Icon name="more" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

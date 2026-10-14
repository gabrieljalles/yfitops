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
}: {
  ids: string[];
  empty?: string;
  /** Mostra um botão para tirar a música da lista (ex.: dentro de um grupo). */
  onRemove?: (id: string) => void;
}) {
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
          <li key={id} className={id === current ? "active" : ""}>
            <button className="track-main" onClick={() => playList(rows.map(([x]) => x), i)}>
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
            {onRemove ? (
              <button className="icon-btn" title="Tirar do grupo" onClick={() => onRemove(id)}>
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

import { getTrackFrom, libraryStore } from "../lib/library";
import { useStore } from "../lib/observable";
import { cycleRepeat, jumpTo, next, playerStore, prev, seek, toggle, toggleShuffle } from "../lib/player";
import { formatTime } from "../lib/tracks";
import { openTrack, uiStore } from "../lib/ui";
import { Cover } from "./Cover";
import { Icon } from "./Icon";

function useCurrent() {
  const p = useStore(playerStore);
  const lib = useStore(libraryStore);
  const id = p.queue[p.index];
  return { p, id, track: id ? getTrackFrom(lib, id) : undefined, lib };
}

export function PlayerBar() {
  const { p, track } = useCurrent();
  if (!track) return null;
  const pct = p.duration ? (p.time / p.duration) * 100 : 0;
  return (
    <div className="player-bar">
      <div className="bar-progress" style={{ width: `${pct}%` }} />
      <button className="bar-info" onClick={() => uiStore.set((s) => ({ ...s, fullPlayer: true }))}>
        <Cover cover={track.cover} seed={track.title + track.artist} size={42} spinning={p.playing} sleeve />
        <span className="track-text">
          <span className="track-title">{track.title}</span>
          <span className="track-sub">{p.error ?? (p.loading ? "carregando…" : track.artist || "Artista desconhecido")}</span>
        </span>
      </button>
      <div className="bar-controls">
        <button className="icon-btn hide-sm" onClick={prev} title="Anterior">
          <Icon name="prev" />
        </button>
        <button className="icon-btn play" onClick={toggle} title={p.playing ? "Pausar" : "Tocar"}>
          <Icon name={p.playing ? "pause" : "play"} size={22} />
        </button>
        <button className="icon-btn" onClick={() => next()} title="Próxima">
          <Icon name="next" />
        </button>
      </div>
    </div>
  );
}

export function FullPlayer() {
  const { fullPlayer } = useStore(uiStore);
  const { p, id, track, lib } = useCurrent();
  if (!fullPlayer || !track || !id) return null;
  const close = () => uiStore.set((s) => ({ ...s, fullPlayer: false }));
  const upcoming = p.queue.slice(p.index + 1, p.index + 30);
  return (
    <div className="full-player">
      <header>
        <button className="icon-btn" onClick={close} title="Minimizar">
          <Icon name="down" />
        </button>
        <span className="muted small">tocando agora</span>
        <button className="icon-btn" onClick={() => openTrack(id)} title="Mais opções">
          <Icon name="more" />
        </button>
      </header>
      <div className="fp-body">
        <Cover cover={track.cover} seed={track.title + track.artist} spinning={p.playing} sleeve className="fp-cover" />
        <div className="fp-meta">
          <h2>{track.title}</h2>
          <p className="muted">{[track.artist, track.album].filter(Boolean).join(" · ") || "Artista desconhecido"}</p>
          {p.error && <p className="error">{p.error}</p>}
        </div>
        <div className="fp-seek">
          <input
            type="range"
            min={0}
            max={p.duration || 0}
            step={0.5}
            value={Math.min(p.time, p.duration || 0)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Posição"
          />
          <div className="fp-times muted small">
            <span>{formatTime(p.time)}</span>
            <span>{formatTime(p.duration)}</span>
          </div>
        </div>
        <div className="fp-controls">
          <button className={`icon-btn${p.shuffle ? " on" : ""}`} onClick={toggleShuffle} title="Aleatório">
            <Icon name="shuffle" />
          </button>
          <button className="icon-btn" onClick={prev} title="Anterior">
            <Icon name="prev" size={28} />
          </button>
          <button className="icon-btn play big" onClick={toggle} title={p.playing ? "Pausar" : "Tocar"}>
            <Icon name={p.playing ? "pause" : "play"} size={32} />
          </button>
          <button className="icon-btn" onClick={() => next()} title="Próxima">
            <Icon name="next" size={28} />
          </button>
          <button className={`icon-btn${p.repeat !== "off" ? " on" : ""}`} onClick={cycleRepeat} title={`Repetir: ${p.repeat}`}>
            <Icon name="repeat" />
            {p.repeat === "one" && <span className="repeat-one">1</span>}
          </button>
        </div>
        {upcoming.length > 0 && (
          <div className="fp-queue">
            <h4>A seguir</h4>
            <ul>
              {upcoming.map((qid, i) => {
                const t = getTrackFrom(lib, qid);
                return (
                  t && (
                    <li key={`${qid}-${i}`}>
                      <button onClick={() => jumpTo(p.index + 1 + i)}>
                        <span className="track-title">{t.title}</span>
                        <span className="track-sub">{t.artist}</span>
                      </button>
                    </li>
                  )
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

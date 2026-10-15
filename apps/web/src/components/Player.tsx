import { getTrackFrom, libraryStore } from "../lib/library";
import { useStore } from "../lib/observable";
import { cycleRepeat, jumpTo, next, playerStore, prev, seek, toggle, toggleShuffle, type PlayerState } from "../lib/player";
import { formatTime } from "../lib/tracks";
import { openTrack, uiStore } from "../lib/ui";
import { Cover } from "./Cover";
import { FavoriteButton } from "./FavoriteButton";
import { Icon } from "./Icon";

/** Enquanto a música carrega: "baixando… 42%" (não está no aparelho) ou "carregando…". Curto: cabe no celular. */
function loadingText(p: PlayerState): string | null {
  if (!p.loading) return null;
  return p.progress != null ? `baixando… ${Math.round(p.progress * 100)}%` : "carregando…";
}

/** Há próxima na fila? (Tocou uma só, pela busca: não há, e o botão fica apagado.) */
const hasNext = (p: PlayerState) => p.index + 1 < p.queue.length || (p.repeat === "all" && p.queue.length > 1);

function useCurrent() {
  const p = useStore(playerStore);
  const lib = useStore(libraryStore);
  const id = p.queue[p.index];
  return { p, id, track: id ? getTrackFrom(lib, id) : undefined, lib };
}

export function PlayerBar() {
  const { p, id, track } = useCurrent();
  if (!track) return null;
  const pct = p.duration ? (p.time / p.duration) * 100 : 0;
  return (
    <div className="player-bar">
      <div className="bar-progress" style={{ width: `${pct}%` }} />
      <button className="bar-info" onClick={() => uiStore.set((s) => ({ ...s, fullPlayer: true }))}>
        <Cover cover={track.cover} seed={track.title + track.artist} size={42} spinning={p.playing} sleeve />
        <span className="track-text">
          <span className="track-title">{track.title}</span>
          <span className="track-sub">{p.error ?? loadingText(p) ?? (track.artist || "Artista desconhecido")}</span>
        </span>
      </button>
      <div className="bar-controls">
        <FavoriteButton id={id!} />
        <button className="icon-btn hide-sm" onClick={prev} title="Anterior">
          <Icon name="prev" />
        </button>
        <button className={`icon-btn play${p.loading ? " loading" : ""}`} onClick={toggle} title={p.playing ? "Pausar" : "Tocar"}>
          <Icon name={p.playing ? "pause" : "play"} size={22} />
        </button>
        <button className="icon-btn" onClick={() => next()} disabled={!hasNext(p)} title={hasNext(p) ? "Próxima" : "Não há próxima na fila"}>
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
          <div className="fp-title-row">
            <h2>{track.title}</h2>
            <FavoriteButton id={id} size={24} />
          </div>
          <p className="muted">{[track.artist, track.album].filter(Boolean).join(" · ") || "Artista desconhecido"}</p>
          {p.error ? (
            <p className="error">{p.error}</p>
          ) : (
            p.loading && (
              <p className="muted small" role="status">
                {loadingText(p)}
              </p>
            )
          )}
        </div>
        <div className="fp-seek">
          <input
            type="range"
            min={0}
            max={p.duration || 0}
            step={0.5}
            value={Math.min(p.time, p.duration || 0)}
            onChange={(e) => seek(Number(e.target.value))}
            style={{ "--pct": `${p.duration ? (Math.min(p.time, p.duration) / p.duration) * 100 : 0}%` } as React.CSSProperties}
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
          <button className={`icon-btn play big${p.loading ? " loading" : ""}`} onClick={toggle} title={p.playing ? "Pausar" : "Tocar"}>
            <Icon name={p.playing ? "pause" : "play"} size={32} />
          </button>
          <button className="icon-btn" onClick={() => next()} disabled={!hasNext(p)} title={hasNext(p) ? "Próxima" : "Não há próxima na fila"}>
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
                        <Cover cover={t.cover} seed={t.title + t.artist} size={40} />
                        <span className="track-text">
                          <span className="track-title">{t.title}</span>
                          <span className="track-sub">{t.artist}</span>
                        </span>
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

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { isOffline, offlineStore } from "../lib/blobs";
import { getTrackFrom, libraryStore } from "../lib/library";
import { useStore } from "../lib/observable";
import { playerStore, playList } from "../lib/player";
import { formatTime } from "../lib/tracks";
import { openTrack } from "../lib/ui";
import { Cover } from "./Cover";
import { Icon } from "./Icon";
import { WithLocalBadge } from "./LocalBadge";

export function TrackList({
  ids,
  empty = "Nada por aqui ainda.",
  onRemove,
  onReorder,
  selected,
  onToggle,
}: {
  ids: string[];
  empty?: string;
  /** Mostra um botão para tirar a música da lista (ex.: dentro de uma playlist). */
  onRemove?: (id: string) => void;
  /** Mostra uma alça para arrastar a música para cima ou para baixo (ex.: editando uma playlist). */
  onReorder?: (ids: string[]) => void;
  /** Modo de seleção: tocar numa linha marca/desmarca em vez de tocar a música. */
  selected?: Set<string>;
  onToggle?: (id: string) => void;
}) {
  const selecting = !!selected && !!onToggle;
  const lib = useStore(libraryStore);
  const player = useStore(playerStore);
  const offline = useStore(offlineStore);
  const current = player.queue[player.index];
  const drag = useReorder(ids, onReorder);
  const rows = drag.ids.map((id) => [id, getTrackFrom(lib, id)] as const).filter(([, t]) => t);

  if (!rows.length) return <p className="muted empty">{empty}</p>;

  return (
    <ul className="tracks" ref={drag.list}>
      {rows.map(([id, t], i) => {
        const downloaded = Object.values(t!.variants).some((v) => isOffline(offline, v));
        return (
          <li
            key={id}
            data-id={id}
            className={`${id === current ? "active" : ""}${selected?.has(id) ? " selected" : ""}${drag.dragging === id ? " dragging" : ""}`}
          >
            {onReorder && !selecting && (
              <button
                className="icon-btn drag-handle"
                title="Arraste para mudar a ordem"
                aria-label={`Mover "${t!.title}" (setas para cima e para baixo)`}
                onPointerDown={(e) => drag.start(e, id)}
                onKeyDown={(e) => drag.key(e, id)}
              >
                <Icon name="grip" size={18} />
              </button>
            )}
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
              <WithLocalBadge local={t!.local}>
                <Cover cover={t!.cover} seed={t!.title + t!.artist} size={44} />
              </WithLocalBadge>
              <span className="track-text">
                <span className="track-title">{t!.title}</span>
                <span className="track-sub">
                  {t!.favoriteAt && (
                    <span className="badge fav" title="Favorita">
                      <Icon name="heartFilled" size={12} />
                    </span>
                  )}
                  {downloaded && !t!.local && (
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

/**
 * Arrastar para reordenar, pela alça de cada linha (dedo ou mouse). A lista muda na
 * hora enquanto arrasta; a ordem nova é salva ao soltar. Perto da borda da tela, a
 * página rola sozinha. Pelo teclado: setas para cima e para baixo na alça.
 */
function useReorder(ids: string[], onReorder?: (ids: string[]) => void) {
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const state = useRef<{ id: string; y: number; order: string[]; scroll?: number } | null>(null);

  /** Troca com a vizinha enquanto o dedo passa do meio dela. */
  const place = () => {
    const s = state.current;
    if (!s || !list.current) return;
    const items = [...list.current.querySelectorAll<HTMLElement>(":scope > li[data-id]")];
    let next = s.order;
    for (;;) {
      const i = next.indexOf(s.id);
      const above = items.find((el) => el.dataset.id === next[i - 1])?.getBoundingClientRect();
      const below = items.find((el) => el.dataset.id === next[i + 1])?.getBoundingClientRect();
      const to = above && s.y < above.top + above.height / 2 ? i - 1 : below && s.y > below.top + below.height / 2 ? i + 1 : i;
      if (to === i) break;
      next = [...next];
      [next[i], next[to]] = [next[to], next[i]];
    }
    if (next !== s.order) {
      s.order = next;
      setOrder(next);
    }
  };

  const autoScroll = () => {
    const s = state.current;
    if (!s) return;
    const edge = 90;
    const speed = s.y < edge ? -(edge - s.y) / 6 : s.y > innerHeight - edge ? (s.y - (innerHeight - edge)) / 6 : 0;
    if (speed) {
      scrollParent(list.current)?.scrollBy(0, speed);
      place();
    }
    s.scroll = requestAnimationFrame(autoScroll);
  };

  // O dedo é acompanhado na janela inteira: a linha muda de lugar enquanto arrasta, e
  // um elemento que muda de lugar perde a "captura" do dedo (aí o soltar se perdia).
  const start = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (!onReorder || state.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    const pointer = e.pointerId;
    const move = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointer || !state.current) return;
      ev.preventDefault();
      state.current.y = ev.clientY;
      place();
    };
    const end = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      const s = state.current;
      state.current = null;
      if (!s) return;
      if (s.scroll) cancelAnimationFrame(s.scroll);
      if (s.order.some((x, i) => x !== ids[i])) onReorder(s.order);
      setOrder(null);
      setDragging(null);
    };
    addEventListener("pointermove", move, { passive: false });
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
    state.current = { id, y: e.clientY, order: ids };
    setOrder(ids);
    setDragging(id);
    state.current.scroll = requestAnimationFrame(autoScroll);
  };

  const key = (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    const i = ids.indexOf(id);
    if (!step || !onReorder || !ids[i + step]) return;
    e.preventDefault();
    const next = [...ids];
    [next[i], next[i + step]] = [next[i + step], next[i]];
    onReorder(next);
    // A alça continua focada na mesma música, agora na posição nova.
    const target = e.currentTarget;
    requestAnimationFrame(() => target.focus());
  };

  return { ids: order ?? ids, dragging, list, start, key };
}

/** O que rola a página (a lista pode estar dentro de uma área com rolagem própria). */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement as HTMLElement | null;
}

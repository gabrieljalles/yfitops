import { useRef } from "react";

/**
 * Deixa arrastar uma lista horizontal com o mouse (no toque, o navegador já faz).
 * Se o arraste andou mais que alguns pixels, o clique que vem no fim é engolido,
 * para soltar o mouse em cima de uma capa não tocar a música sem querer.
 */
export function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent<T>) => {
    if (e.pointerType !== "mouse" || e.button !== 0 || !ref.current) return;
    drag.current = { x: e.clientX, left: ref.current.scrollLeft, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<T>) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) > 5) {
      d.moved = true;
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging"); // desliga o snap enquanto arrasta
    }
    if (d.moved) el.scrollLeft = d.left - dx;
  };
  const end = () => {
    ref.current?.classList.remove("dragging");
    // Mantém `moved` até o clique (que vem logo depois do pointerup) ser engolido.
    setTimeout(() => (drag.current = null));
  };
  const onClickCapture = (e: React.MouseEvent<T>) => {
    if (drag.current?.moved) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return {
    ref,
    onPointerDown,
    onPointerMove,
    onPointerUp: end,
    onPointerCancel: end,
    onClickCapture,
    // Evita o "arrastar imagem" nativo do navegador ao puxar uma capa.
    onDragStart: (e: React.DragEvent<T>) => e.preventDefault(),
  };
}

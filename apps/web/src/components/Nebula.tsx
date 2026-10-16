import { useEffect, useRef } from "react";
import { beatAt, beatMap } from "../lib/beat";
import { nowPlayingFile, playbackTime } from "../lib/player";

/**
 * Nebulosa atrás do vinil do player: três manchas de luz em tons vizinhos da cor
 * da capa, girando devagar e inchando com a batida da música que está tocando.
 * Anima direto no DOM (sem re-render do React) e só enquanto estiver na tela.
 */
export function Nebula({ color, playing }: { color: string | null; playing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  // Cores: a da capa e duas vizinhas (girando o tom 38° para cada lado).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const [h, sat, l] = parseHsl(color) ?? [295, 60, 70];
    [0, 38, -42].forEach((shift, i) => {
      const tone = `${(h + shift + 360) % 360} ${sat}% ${l}%`;
      (el.children[i] as HTMLElement).style.background = `radial-gradient(circle, hsl(${tone} / 0.95), hsl(${tone} / 0) 66%)`;
    });
  }, [color]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const blobs = [...el.children] as HTMLElement[];
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = performance.now();
    let spin = 0;
    let energy = 0;
    let glow = 0.2;
    let clock = 0;
    let key: string | null = null;
    let map: Uint8Array | null = null;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      clock += dt;
      const playing = playingRef.current;

      // Música trocou: pede o mapa dela (calculado uma vez e guardado).
      const file = nowPlayingFile();
      if (file && file.key !== key) {
        key = file.key;
        map = null;
        const wanted = key;
        void beatMap(file.key, file.url).then((m) => {
          if (key === wanted) map = m;
        });
      }

      const target = playing && map && !reduced ? beatAt(map, playbackTime()) : 0;
      // Sobe na hora, desce devagar: o olho percebe a batida, não o tremor.
      energy = target > energy ? target : energy + (target - energy) * Math.min(1, dt * 7);
      const idle = playing ? 0.18 + 0.06 * Math.sin(clock * 1.3) : 0.12;
      glow += (Math.max(idle, energy) - glow) * Math.min(1, dt * 5);
      if (playing && !reduced) spin += dt * (0.5 + glow * 0.8);

      const box = el.getBoundingClientRect();
      const R = box.height * 0.5;
      blobs.forEach((b, i) => {
        const a = spin + (i * Math.PI * 2) / 3;
        const x = Math.cos(a) * R * 0.42;
        const y = Math.sin(a * 1.15) * R * 0.3;
        const s = 0.8 + glow * 0.35 + energy * 0.35;
        b.style.transform = `translate(calc(-50% + ${x.toFixed(1)}px), calc(-50% + ${y.toFixed(1)}px)) scale(${s.toFixed(3)})`;
        b.style.opacity = Math.min(1, 0.35 + glow * 0.6).toFixed(3);
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="nebula" ref={ref} aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}

/** "hsl(295 60% 70%)" (de dominantColor) → [295, 60, 70]. */
function parseHsl(c: string | null): [number, number, number] | null {
  const m = c && /hsl\(\s*([\d.]+)[ ,]+([\d.]+)%[ ,]+([\d.]+)%/.exec(c);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

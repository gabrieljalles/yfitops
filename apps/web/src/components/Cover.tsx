import { useEffect, useState } from "react";
import type { BlobRef } from "@yfitops/core";
import { coverUrl } from "../lib/blobs";
import { dominantColor } from "../lib/color";

function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Capa padrão: um vinil desenhado em SVG, com o rótulo colorido pelo nome. Custo zero. */
export function Vinyl({
  seed,
  spinning,
  label,
  groove,
  mini,
}: {
  seed: string;
  spinning?: boolean;
  /** Cor do rótulo (aceita var(--…)); padrão: derivada do nome. */
  label?: string;
  /** Cor dos sulcos (aceita var(--…)); padrão: --vinyl-groove. */
  groove?: string;
  /** Versão de ícone: menos sulcos e rótulo maior, para a cor aparecer em tamanhos pequenos. */
  mini?: boolean;
}) {
  const h = hue(seed);
  return (
    <svg viewBox="0 0 100 100" className={`vinyl${spinning ? " spin" : ""}`} aria-hidden="true">
      <circle cx="50" cy="50" r="49" fill="var(--vinyl)" />
      {(mini ? [40] : [42, 37, 32, 27]).map((r) => (
        <circle key={r} cx="50" cy="50" r={r} fill="none" style={{ stroke: groove ?? "var(--vinyl-groove)" }} strokeWidth="0.6" />
      ))}
      <path d="M50 8 A42 42 0 0 1 86 30" fill="none" stroke="var(--vinyl-shine)" strokeWidth="2" strokeLinecap="round" />
      {/* style (e não o atributo fill), pois atributos de SVG não resolvem var(--…) */}
      <circle cx="50" cy="50" r={mini ? 26 : 17} style={{ fill: label ?? `hsl(${h} 38% 72%)` }} />
      <circle cx="50" cy="50" r={mini ? 4 : 2.2} style={{ fill: "var(--bg)" }} />
    </svg>
  );
}

/** Endereço local da capa (carrega quando muda). */
function useCoverSrc(cover?: BlobRef): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (cover) coverUrl(cover).then((u) => alive && setSrc(u), () => {});
    return () => {
      alive = false;
    };
  }, [cover?.id]);
  return src;
}

/**
 * Capa de playlist: as capas das primeiras músicas empilhadas, uma atrás da outra,
 * como discos num caixote. Ao passar o mouse, a da frente sobe do chão e o vinil
 * sai de dentro dela (só CSS; ver .crate).
 */
export function Crate({ covers, seed }: { covers: BlobRef[]; seed: string }) {
  const [front, ...back] = covers;
  const src = useCoverSrc(front);
  const [tint, setTint] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setTint(null);
    if (src && front) dominantColor(front.id, src).then((c) => alive && setTint(c));
    return () => {
      alive = false;
    };
  }, [src, front?.id]);
  const h = hue(seed);
  // Sem capas suficientes, as de trás são capas lisas no tom da playlist.
  const backs = [0, 1].map((i) => back[i]);
  return (
    <div className="crate">
      {backs
        .map((c, i) =>
          c ? (
            <Cover key={i} cover={c} seed={seed} className={`crate-back b${i + 1}`} />
          ) : (
            <div key={i} className={`crate-back b${i + 1} blank`} style={{ background: `hsl(${(h + 40 * (i + 1)) % 360} 22% 34%)` }} />
          ),
        )
        .reverse()}
      <div className="crate-front">
        <div className="crate-disc">
          <Vinyl seed={seed} label={tint ?? undefined} />
        </div>
        {src ? (
          <div className="cover">
            <img src={src} alt="" loading="lazy" />
          </div>
        ) : (
          <div className="cover blank" style={{ background: `hsl(${h} 30% 42%)` }}>
            <span>{seed.trim().charAt(0).toUpperCase()}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function Cover({
  cover,
  seed,
  size,
  spinning,
  sleeve,
  className = "",
}: {
  cover?: BlobRef;
  seed: string;
  size?: number;
  spinning?: boolean;
  /** Com capa: o vinil sai pela direita da capa e gira enquanto `spinning` (só efeito visual). */
  sleeve?: boolean;
  className?: string;
}) {
  const src = useCoverSrc(cover);
  const [tint, setTint] = useState<string | null>(null);
  // Com capa, o rótulo do vinil que sai dela ganha a cor predominante da capa.
  useEffect(() => {
    let alive = true;
    setTint(null);
    if (sleeve && src && cover) dominantColor(cover.id, src).then((c) => alive && setTint(c));
    return () => {
      alive = false;
    };
  }, [sleeve, src, cover?.id]);
  if (sleeve && src) {
    return (
      <div
        className={`sleeve${spinning ? " out" : ""} ${className}`}
        style={size ? ({ width: size, height: size, "--s": `${size}px` } as React.CSSProperties) : undefined}
      >
        <div className="sleeve-disc">
          <Vinyl seed={seed} label={tint ?? undefined} spinning />
        </div>
        <div className="cover">
          <img src={src} alt="" />
        </div>
      </div>
    );
  }
  return (
    <div className={`cover ${className}`} style={size ? { width: size, height: size } : undefined}>
      {src ? <img src={src} alt="" loading="lazy" /> : <Vinyl seed={seed} spinning={spinning} />}
    </div>
  );
}

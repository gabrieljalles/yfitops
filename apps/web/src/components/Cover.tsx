import { useEffect, useState } from "react";
import type { BlobRef } from "@yfitops/core";
import { coverUrl } from "../lib/blobs";

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
  mini,
}: {
  seed: string;
  spinning?: boolean;
  /** Cor do rótulo (aceita var(--…)); padrão: derivada do nome. */
  label?: string;
  /** Versão de ícone: menos sulcos e rótulo maior, para a cor aparecer em tamanhos pequenos. */
  mini?: boolean;
}) {
  const h = hue(seed);
  return (
    <svg viewBox="0 0 100 100" className={`vinyl${spinning ? " spin" : ""}`} aria-hidden="true">
      <circle cx="50" cy="50" r="49" fill="var(--vinyl)" />
      {(mini ? [40] : [42, 37, 32, 27]).map((r) => (
        <circle key={r} cx="50" cy="50" r={r} fill="none" stroke="var(--vinyl-groove)" strokeWidth="0.6" />
      ))}
      <path d="M50 8 A42 42 0 0 1 86 30" fill="none" stroke="var(--vinyl-shine)" strokeWidth="2" strokeLinecap="round" />
      {/* style (e não o atributo fill), pois atributos de SVG não resolvem var(--…) */}
      <circle cx="50" cy="50" r={mini ? 26 : 17} style={{ fill: label ?? `hsl(${h} 38% 72%)` }} />
      <circle cx="50" cy="50" r={mini ? 4 : 2.2} style={{ fill: "var(--bg)" }} />
    </svg>
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
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (cover) coverUrl(cover).then((u) => alive && setSrc(u), () => {});
    return () => {
      alive = false;
    };
  }, [cover?.id]);
  if (sleeve && src) {
    return (
      <div
        className={`sleeve${spinning ? " out" : ""} ${className}`}
        style={size ? ({ width: size, height: size, "--s": `${size}px` } as React.CSSProperties) : undefined}
      >
        <div className="sleeve-disc">
          <Vinyl seed={seed} spinning />
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

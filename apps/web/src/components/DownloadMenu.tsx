import { useEffect, useRef, useState } from "react";
import { hasQualityChoice, isOffline, offlineStore, offlineVariant, type DownloadQuality } from "../lib/blobs";
import { getTrackFrom, libraryStore } from "../lib/library";
import { useStore } from "../lib/observable";
import { downloadSize, downloadTracks, formatBytes, removeDownloads } from "../lib/tracks";
import { attempt } from "../lib/ui";
import { Icon } from "./Icon";

const LABEL: Record<DownloadQuality, { name: string; detail: string }> = {
  normal: { name: "Normal", detail: "Opus 160 kbps, leve" },
  max: { name: "Máxima", detail: "FLAC sem perda" },
};

/** Botão "baixar" que pergunta a qualidade (normal ou máxima) e mostra o tamanho de cada uma. */
export function DownloadMenu({ ids, className }: { ids: string[]; className: string }) {
  const lib = useStore(libraryStore);
  const offline = useStore(offlineStore);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const tracks = ids.map((id) => getTrackFrom(lib, id)).filter((t) => t !== undefined);
  const choice = tracks.some(hasQualityChoice);
  const isAt = (q: DownloadQuality) => tracks.length > 0 && tracks.every((t) => isOffline(offline, offlineVariant(t, q)));
  const any = tracks.some((t) => Object.values(t.variants).some((v) => isOffline(offline, v)));
  const current: DownloadQuality | null = isAt("max") ? "max" : isAt("normal") ? "normal" : null;

  const download = async (q: DownloadQuality) => {
    setOpen(false);
    const ok = ids.length > 1 ? `Disponível offline · ${LABEL[q].name.toLowerCase()}` : "Baixada para ouvir offline";
    await attempt(() => downloadTracks(ids, q, (d, t) => ids.length > 1 && setProgress(`${d}/${t}`)), ok);
    setProgress(null);
  };

  const label = progress ?? (current ? (choice ? `baixado · ${LABEL[current].name.toLowerCase()}` : "baixado") : "baixar");

  return (
    <div className="dl" ref={ref}>
      <button className={className} disabled={!ids.length || progress !== null} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={current ? "check" : "download"} size={14} /> {label}
      </button>
      {open && (
        <div className="dl-menu" role="menu">
          {(choice ? (["normal", "max"] as const) : (["normal"] as const)).map((q) => {
            const at = isAt(q);
            return (
              <button key={q} role="menuitem" disabled={at} onClick={() => download(q)}>
                <span className="dl-name">
                  {choice ? LABEL[q].name : "Baixar"}
                  {at && <Icon name="check" size={14} />}
                </span>
                <span className="muted small">
                  {choice ? `${LABEL[q].detail} · ` : "Versão única · "}
                  {formatBytes(downloadSize(ids, q))}
                </span>
              </button>
            );
          })}
          {any && (
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                setOpen(false);
                void attempt(() => removeDownloads(ids), "Removido do aparelho");
              }}
            >
              <span className="dl-name">Remover do aparelho</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

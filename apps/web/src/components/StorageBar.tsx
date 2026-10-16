import { useEffect } from "react";
import { useStore } from "../lib/observable";
import { formatBytes } from "../lib/tracks";
import { refreshUsage, usageStore, usageTone } from "../lib/usage";

/**
 * Espaço da nuvem, que é um só para todas as contas (as músicas são
 * compartilhadas). `onlyWhenFull`: só aparece quando passa de 80% (aviso na
 * tela de envio); sem ele, sempre aparece (Ajustes).
 */
export function StorageBar({ onlyWhenFull = false }: { onlyWhenFull?: boolean }) {
  const usage = useStore(usageStore);
  useEffect(() => void refreshUsage(), []);
  if (!usage) return null;
  const tone = usageTone(usage);
  if (onlyWhenFull && tone === "ok") return null;
  const pct = Math.min(100, (usage.bytes / usage.quota) * 100);
  const free = Math.max(0, usage.quota - usage.bytes);

  return (
    <div className={`storage ${tone}`}>
      <div
        className="progress"
        role="meter"
        aria-label="Espaço usado na nuvem compartilhada"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div style={{ width: `${pct}%` }} />
      </div>
      <p className="small">
        {tone === "error" ? (
          <strong>Nuvem quase cheia: </strong>
        ) : tone === "warn" ? (
          <strong>Nuvem enchendo: </strong>
        ) : null}
        Nuvem: {formatBytes(usage.bytes)} de {formatBytes(usage.quota)} ({Math.round(pct)}%) · {formatBytes(free)} livres
        {usage.count !== undefined && ` · ${usage.count} ${usage.count === 1 ? "música" : "músicas"}`}
      </p>
      {tone !== "ok" && (
        <p className="small muted">
          Quando encher, ninguém consegue trazer músicas novas. Músicas repetidas não ocupam espaço extra.
        </p>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Vinyl } from "./Cover";

/** Versão deste app (gerada no build; vite.config.ts). */
const APP_VERSION = __APP_VERSION__;
const CHECK_EVERY = 10 * 60_000;

/**
 * Versão publicada agora. O endereço muda a cada pergunta, para nunca vir do cache
 * (nem do service worker, que sem internet devolveria uma cópia guardada).
 */
async function publishedVersion(): Promise<string | null> {
  if (import.meta.env.DEV || !navigator.onLine) return null;
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as { version: string }).version : null;
  } catch {
    return null;
  }
}

/**
 * Aviso obrigatório de versão nova: cobre o app até a pessoa atualizar. Vale no navegador
 * e no app Android (que abre o site publicado): atualizar é só recarregar.
 */
export function UpdatePrompt() {
  const [outdated, setOutdated] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const check = async () => {
      const v = await publishedVersion();
      if (v && v !== APP_VERSION) setOutdated(true);
    };
    void check();
    const onVisible = () => document.visibilityState === "visible" && void check();
    const t = setInterval(() => void check(), CHECK_EVERY);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, []);

  if (!outdated) return null;
  return (
    <div className="update-backdrop" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <div className="update-card">
        <div className="update-disc">
          <Vinyl seed="" label="var(--brand)" spinning={busy} />
        </div>
        <h2 id="update-title">Tem atualização nova</h2>
        <p className="muted">É necessário atualizar para continuar usando. Leva só alguns segundos e seu login e suas músicas continuam.</p>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            location.reload();
          }}
        >
          {busy ? "atualizando…" : "Atualizar agora"}
        </button>
      </div>
    </div>
  );
}

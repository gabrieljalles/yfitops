import { useEffect, useState } from "react";
import { allowBackground, backgroundAllowed, NATIVE_BUILD, nativeBuild } from "../lib/native";
import { spotStore } from "../lib/spot";
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

  // Celular ajudante: ninguém vai tocar no aviso. Recarrega sozinho assim que não
  // estiver baixando nada (o que estava na mão volta para a fila de qualquer jeito).
  useEffect(() => {
    if (!outdated) return;
    const tryReload = () => {
      const s = spotStore.get();
      if (s.helper && !s.doing) location.reload();
    };
    tryReload();
    const stop = spotStore.subscribe(tryReload);
    return () => void stop();
  }, [outdated]);

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

/**
 * App Android antigo (parte nativa mais velha que a que o site espera): pede para
 * instalar o APK novo por cima. O link "http://" abre fora do app, no Chrome, que
 * baixa o arquivo (o servidor manda para o https). Login e músicas continuam.
 */
export function NativeUpdatePrompt() {
  const [old, setOld] = useState(false);
  useEffect(() => {
    void nativeBuild().then((b) => b > 0 && b < NATIVE_BUILD && setOld(true));
  }, []);
  if (!old) return null;
  return (
    <div className="update-backdrop" role="dialog" aria-modal="true" aria-labelledby="native-update-title">
      <div className="update-card">
        <div className="update-disc">
          <Vinyl seed="" label="var(--brand)" />
        </div>
        <h2 id="native-update-title">Atualize o app</h2>
        <p className="muted">Tem uma versão nova do app do Yfitops.</p>
        <ol className="install-steps">
          <li>Toque em <strong>Baixar a versão nova</strong>. O Chrome vai abrir e baixar o arquivo.</li>
          <li>Abra o arquivo baixado e toque em <strong>Atualizar</strong>.</li>
          <li>Seu login e suas músicas continuam.</li>
        </ol>
        <a className="primary install-download" href={`http://${location.host}/api/app/apk`}>
          Baixar a versão nova
        </a>
        <button className="link" onClick={() => setOld(false)}>
          depois
        </button>
      </div>
    </div>
  );
}

/** Quando a pessoa tocou em "depois" (pergunta de novo em 3 dias). */
const BACKGROUND_LATER_KEY = "yfitops.background-later";
const ASK_AGAIN = 3 * 24 * 60 * 60_000;

/**
 * App Android novo sem a bateria liberada: pede para deixar o app funcionar em
 * segundo plano (a tela do próprio Android vem em seguida).
 */
export function BackgroundPrompt() {
  const [ask, setAsk] = useState(false);
  useEffect(() => {
    let later = 0;
    try {
      later = Number(localStorage.getItem(BACKGROUND_LATER_KEY)) || 0;
    } catch {
      /* sem armazenamento: pergunta */
    }
    if (Date.now() - later < ASK_AGAIN) return;
    void backgroundAllowed().then((allowed) => allowed === false && setAsk(true));
  }, []);
  if (!ask) return null;
  const close = () => setAsk(false);
  return (
    <div className="update-backdrop" role="dialog" aria-modal="true" aria-labelledby="background-title">
      <div className="update-card">
        <div className="update-disc">
          <Vinyl seed="" label="var(--brand)" />
        </div>
        <h2 id="background-title">Permita o Yfitops em segundo plano</h2>
        <p className="muted">Na próxima tela, toque em Permitir.</p>
        <button
          className="primary"
          onClick={() => {
            close();
            void allowBackground();
          }}
        >
          Permitir
        </button>
        <button
          className="link"
          onClick={() => {
            try {
              localStorage.setItem(BACKGROUND_LATER_KEY, String(Date.now()));
            } catch {
              /* sem armazenamento: pergunta de novo na próxima vez */
            }
            close();
          }}
        >
          depois
        </button>
      </div>
    </div>
  );
}

import { useState } from "react";
import { isAndroidBrowser, isNativeApp } from "../lib/native";
import { Icon } from "./Icon";
import { Vinyl } from "./Cover";

// O app Android é quem baixa as músicas pedidas por link (o navegador não consegue).
// Por isso ele é oferecido logo de cara, e não só lá dentro de Ajustes.

const APK = "/yfitops.apk";
const DISMISS_KEY = "yfitops.install-app-dismissed";
/** Depois de "agora não", o convite volta em alguns dias (o aviso no topo continua). */
const ASK_AGAIN = { android: 3, other: 14 };
const DAY = 1000 * 60 * 60 * 24;

type Where = "android" | "other" | null;

/** Onde estamos: navegador do Android (pode instalar), outro aparelho (computador, iPhone) ou já no app. */
function where(): Where {
  if (isNativeApp()) return null;
  return isAndroidBrowser() ? "android" : "other";
}

function dismissedRecently(w: Exclude<Where, null>): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return Date.now() - at < ASK_AGAIN[w] * DAY;
  } catch {
    return false;
  }
}

function dismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* sem armazenamento: o convite volta na próxima vez */
  }
}

const WHY = "É pelo app Android que as músicas que você pede chegam. Sem ele, seus pedidos ficam na fila esperando.";

/** Botão de baixar o APK. */
function DownloadButton({ onClick }: { onClick?: () => void }) {
  return (
    <a className="primary install-download" href={APK} download="yfitops.apk" onClick={onClick}>
      <Icon name="download" size={18} /> Baixar o app Android
    </a>
  );
}

/** Convite que aparece logo depois de entrar, cobrindo a tela. */
export function InstallAppPrompt() {
  const w = where();
  const [open, setOpen] = useState(() => w !== null && !dismissedRecently(w));
  const [downloaded, setDownloaded] = useState(false);
  if (!w || !open) return null;

  const close = () => {
    dismiss();
    setOpen(false);
  };

  return (
    <div className="install-backdrop" role="dialog" aria-modal="true" aria-labelledby="install-title">
      <div className="install-card">
        <div className="install-disc">
          <Vinyl seed="" label="var(--brand)" spinning />
        </div>
        <h2 id="install-title">{w === "android" ? "Instale o app do Yfitops" : "Tem celular Android?"}</h2>
        <p className="install-why">
          <strong>Importante:</strong> {WHY}
        </p>
        {w === "android" ? (
          <>
            <ol className="install-steps">
              <li>Toque em <strong>Baixar o app Android</strong> (3,5 MB, de preferência no Wi-Fi).</li>
              <li>Abra o arquivo baixado. Se o Android perguntar, <strong>permita instalar</strong> desta fonte.</li>
              <li>
                Toque em <strong>Instalar</strong> e abra pelo ícone novo do Yfitops. Entre com o mesmo e-mail e senha.
              </li>
            </ol>
            <DownloadButton onClick={() => setDownloaded(true)} />
            {downloaded && <p className="muted small">Baixou? Abra o arquivo pela notificação ou pela pasta Downloads.</p>}
          </>
        ) : (
          <p className="muted">
            Abra <strong>{location.host}</strong> no navegador do celular Android e toque em <strong>Baixar o app Android</strong>. Depois de
            instalado, ele também baixa os pedidos que você fizer daqui.
          </p>
        )}
        <button className="link" onClick={close}>
          {w === "android" ? "agora não" : "entendi"}
        </button>
      </div>
    </div>
  );
}

/** Aviso fixo no topo (só no navegador do Android), para quem fechou o convite. */
export function InstallAppBanner() {
  if (where() !== "android") return null;
  return (
    <div className="install-banner">
      <span>
        <strong>Instale o app Android.</strong> {WHY}
      </span>
      <DownloadButton />
    </div>
  );
}

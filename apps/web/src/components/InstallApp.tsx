import { useState } from "react";
import { isAndroidBrowser, isNativeApp } from "../lib/native";
import { createStore, useStore } from "../lib/observable";
import { attempt } from "../lib/ui";
import { Icon } from "./Icon";
import { Vinyl } from "./Cover";

// Convite para instalar, conforme o aparelho de quem abriu:
//   - Android: o app (APK). É ele que baixa as músicas pedidas por link;
//   - iPhone/iPad: "Adicionar à Tela de Início" no Safari (não existe app para iPhone);
//   - computador: como instalar no celular Android.
// Quem já está no app (ou abriu o iPhone pelo ícone) não vê nada.

const APK = "/yfitops.apk";
const DISMISS_KEY = "yfitops.install-app-dismissed";
/** Depois de "agora não", o convite volta em alguns dias (o aviso no topo continua). */
const ASK_AGAIN = { android: 3, ios: 3, other: 14 };
const DAY = 1000 * 60 * 60 * 24;

type Device = "android" | "ios" | "other";

/** iPhone, iPod ou iPad (o iPad novo se apresenta como Mac, mas tem tela de toque). */
const isIOS = () =>
  /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** Aberto pelo ícone da tela de início (já "instalado"). */
const isStandalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;

/** No iPhone, só o Safari tem o "Adicionar à Tela de Início" sempre à mão. */
const isIOSSafari = () => !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//i.test(navigator.userAgent);

/** Que convite mostrar aqui (null = nenhum). */
function device(): Device | null {
  if (isNativeApp()) return null;
  if (isAndroidBrowser()) return "android";
  if (isIOS()) return isStandalone() ? null : "ios";
  return "other";
}

function dismissedRecently(d: Device): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(DISMISS_KEY) ?? 0) < ASK_AGAIN[d] * DAY;
  } catch {
    return false;
  }
}

function rememberDismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* sem armazenamento: o convite volta na próxima vez */
  }
}

/** O convite aberto (o aviso do topo reabre com "como instalar"). */
const openStore = createStore<boolean | null>(null);

const WHY_ANDROID = "É pelo app Android que as músicas que você pede chegam. Sem ele, seus pedidos ficam na fila esperando.";
const WHY_IOS = "No iPhone, o Yfitops vira um app na tela de início: abre em tela cheia, com o login salvo, sem precisar de loja.";

function DownloadButton({ onClick }: { onClick?: () => void }) {
  return (
    <a className="primary install-download" href={APK} download="yfitops.apk" onClick={onClick}>
      <Icon name="download" size={18} /> Baixar o app Android
    </a>
  );
}

/** Passo a passo do Android: baixar e instalar o APK. */
function AndroidSteps() {
  const [downloaded, setDownloaded] = useState(false);
  return (
    <>
      <p className="install-why">
        <strong>Importante:</strong> {WHY_ANDROID}
      </p>
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
  );
}

/** Passo a passo do iPhone: adicionar à tela de início pelo Safari. */
function IOSSteps() {
  if (!isIOSSafari()) {
    return (
      <>
        <p className="install-why">{WHY_IOS}</p>
        <ol className="install-steps">
          <li>
            Copie o endereço e abra no <strong>Safari</strong> (é nele que a opção aparece).
          </li>
          <li>
            No Safari, siga os passos que vão aparecer lá: <strong>Compartilhar</strong> → <strong>Adicionar à Tela de Início</strong>.
          </li>
        </ol>
        <button
          className="primary install-download"
          onClick={() =>
            void attempt(() => navigator.clipboard.writeText(location.origin), "Endereço copiado: agora cole no Safari")
          }
        >
          Copiar o endereço
        </button>
      </>
    );
  }
  return (
    <>
      <p className="install-why">{WHY_IOS}</p>
      <ol className="install-steps">
        <li>
          Toque no botão <strong>Compartilhar</strong>{" "}
          <span className="install-glyph" aria-hidden="true">
            <Icon name="upload" size={16} />
          </span>{" "}
          do Safari (na barra de baixo ou de cima).
        </li>
        <li>
          Role a lista e toque em <strong>Adicionar à Tela de Início</strong>.
        </li>
        <li>
          Toque em <strong>Adicionar</strong>. Daqui para frente, abra o Yfitops pelo ícone novo.
        </li>
      </ol>
      <p className="muted small">Os pedidos que você fizer pelo iPhone são baixados pelos celulares Android da família.</p>
    </>
  );
}

/** Convite em tela cheia, logo depois de entrar (e quando o aviso do topo pede). */
export function InstallAppPrompt() {
  const d = device();
  const forced = useStore(openStore);
  const [auto, setAuto] = useState(() => d !== null && !dismissedRecently(d));
  const open = forced ?? auto;
  if (!d || !open) return null;

  const close = () => {
    rememberDismiss();
    setAuto(false);
    openStore.set(false);
  };

  const title = d === "android" ? "Instale o app do Yfitops" : d === "ios" ? "Coloque o Yfitops na tela de início" : "Tem celular Android?";

  return (
    <div className="install-backdrop" role="dialog" aria-modal="true" aria-labelledby="install-title">
      <div className="install-card">
        <div className="install-disc">
          <Vinyl seed="" label="var(--brand)" spinning />
        </div>
        <h2 id="install-title">{title}</h2>
        {d === "android" && <AndroidSteps />}
        {d === "ios" && <IOSSteps />}
        {d === "other" && (
          <>
            <p className="install-why">
              <strong>Importante:</strong> {WHY_ANDROID}
            </p>
            <p className="muted">
              Abra <strong>{location.host}</strong> no navegador do celular Android e toque em <strong>Baixar o app Android</strong>. Depois
              de instalado, ele também baixa os pedidos que você fizer daqui.
            </p>
          </>
        )}
        <button className="link" onClick={close}>
          {d === "other" ? "entendi" : "agora não"}
        </button>
      </div>
    </div>
  );
}

/** Aviso fixo no topo, no celular, até instalar. */
export function InstallAppBanner() {
  const d = device();
  if (d === "android") {
    return (
      <div className="install-banner">
        <span>
          <strong>Instale o app Android.</strong> {WHY_ANDROID}
        </span>
        <DownloadButton />
      </div>
    );
  }
  if (d === "ios") {
    return (
      <div className="install-banner">
        <span>
          <strong>Coloque o Yfitops na tela de início</strong> e abra pelo ícone, como um app.
        </span>
        <button className="primary install-download" onClick={() => openStore.set(true)}>
          Ver como
        </button>
      </div>
    );
  }
  return null;
}

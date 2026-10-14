import { prefsStore } from "./prefs";

// Avisos do sistema quando uma importação/envio termina com o app em segundo
// plano (outra aba, tela bloqueada) ou em outra tela do app.

const supported = () => typeof Notification !== "undefined";

/** Estado da permissão: "unsupported" quando o navegador não tem avisos. */
export function notifyPermission(): NotificationPermission | "unsupported" {
  return supported() ? Notification.permission : "unsupported";
}

/**
 * Pede permissão na hora em que a pessoa começa algo demorado (precisa ser
 * chamado a partir de um clique). Só pergunta uma vez, e só com os avisos ligados.
 */
export async function askNotifyPermission(): Promise<void> {
  if (!supported() || !prefsStore.get().notify || Notification.permission !== "default") return;
  try {
    await Notification.requestPermission();
  } catch {
    /* navegador antigo sem a versão com Promise: fica sem avisos */
  }
}

/** Mostra um aviso, a não ser que a pessoa já esteja olhando a tela de envio. */
export async function notify(title: string, body: string) {
  if (!supported() || !prefsStore.get().notify || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && location.hash.startsWith("#/enviar")) return;
  const options: NotificationOptions = { body, icon: "/icon-192.png", badge: "/icon-192.png", tag: "yfitops-import" };
  try {
    // No celular, avisos só funcionam pelo service worker.
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, options);
    else new Notification(title, options);
  } catch {
    /* sem permissão no meio do caminho: ignora */
  }
}

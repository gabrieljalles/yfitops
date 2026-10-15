import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { Network } from "@capacitor/network";
import { fromB64 } from "@yfitops/core";

// ---------------------------------------------------------------------------
// O app Android (APK) é o mesmo site, aberto dentro de uma casca nativa. A casca
// dá duas coisas que o navegador não dá:
//   - pedidos HTTP sem a trava de CORS (o YouTube não deixa outros sites baixarem);
//   - saber se o celular está no Wi-Fi e continuar vivo com a tela desligada.
// É isso que deixa o celular ajudar a baixar as músicas pedidas (ver spot.ts).
// ---------------------------------------------------------------------------

/** Para testar no computador: Chrome aberto com --disable-web-security e esta chave no localStorage. */
const DEBUG_KEY = "yfitops.spot-debug";

function debugSpot(): boolean {
  try {
    return localStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

/** Está rodando dentro do app Android? */
export const isNativeApp = () => Capacitor.isNativePlatform();

/** Este aparelho pode baixar do YouTube? (só no app Android, ou no modo de teste) */
export const canSpot = () => isNativeApp() || debugSpot();

/** É um celular Android, no navegador (pode instalar o app)? */
export const isAndroidBrowser = () => !isNativeApp() && /Android/i.test(navigator.userAgent);

/**
 * `fetch` sem CORS (pelo Android). Mesmo formato do `fetch`. O corpo da resposta
 * atravessa a ponte em base64: serve para páginas, JSON e pedaços de áudio.
 */
export async function nativeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (!isNativeApp()) return fetch(input, init);
  const req = input instanceof Request ? input : null;
  const url = req ? req.url : String(input);
  const method = (init.method ?? req?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init.headers ?? req?.headers).forEach((v, k) => (headers[k] = v));
  // Sem User-Agent, o Android manda o dele ("Dalvik/...") e o YouTube responde
  // "confirme que não é um robô". O do próprio WebView passa.
  headers["user-agent"] ??= navigator.userAgent;
  let data: unknown = init.body ?? undefined;
  if (data !== undefined && typeof data !== "string") data = await new Response(data as BodyInit).text();
  // JSON vai como objeto: o lado nativo serializa de novo (string viraria texto com aspas).
  if (typeof data === "string" && /json/i.test(headers["content-type"] ?? "")) {
    try {
      data = JSON.parse(data);
    } catch {
      /* não era JSON: vai como texto */
    }
  }
  const res = await CapacitorHttp.request({ url, method, headers, data, responseType: "arraybuffer", connectTimeout: 20_000, readTimeout: 60_000 });
  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers ?? {})) out.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  // O lado nativo só respeita o "arraybuffer" (base64) em respostas de sucesso que não
  // são JSON. JSON chega já lido (objeto), a não ser que não dê para ler: aí chega o
  // texto cru (ex.: o ")]}'" na frente do JSON do YouTube) e vai como veio. Erro chega como texto.
  const json = /json/i.test(out.get("content-type") ?? "");
  const body =
    res.status < 400 && !json && typeof res.data === "string"
      ? fromB64(res.data.replace(/\s+/g, ""))
      : new TextEncoder().encode(typeof res.data === "string" ? res.data : res.data === undefined ? "" : JSON.stringify(res.data));
  const empty = [101, 204, 205, 304].includes(res.status);
  return new Response(empty ? null : body, { status: res.status, headers: out });
}

/** O celular está no Wi-Fi? (no computador de teste: sim) */
export async function onWifi(): Promise<boolean> {
  if (!isNativeApp()) return debugSpot();
  try {
    return (await Network.getStatus()).connectionType === "wifi";
  } catch {
    return false;
  }
}

/** Avisa quando a conexão muda (entrou ou saiu do Wi-Fi). */
export function watchNetwork(cb: () => void): void {
  if (isNativeApp()) void Network.addListener("networkStatusChange", cb);
  else addEventListener("online", cb);
}

interface KeepAlivePlugin {
  /** Mantém o app vivo com a tela desligada enquanto toca (notificação "Tocando"). */
  start(opts: { title: string; text: string }): Promise<void>;
  stop(): Promise<void>;
  /** Segura o Wi-Fi e o processador acordados durante um download. */
  busy(opts: { on: boolean }): Promise<void>;
  /** "pause": tocaram em "Pausar" na notificação. */
  addListener(event: "action", cb: (e: { action: string }) => void): Promise<{ remove: () => Promise<void> }>;
}

const KeepAlive = registerPlugin<KeepAlivePlugin>("YfitopsKeepAlive");

/** Música tocando no app Android: o sistema não fecha o app com a tela desligada. */
export function keepAlive(playing: boolean, title = "", text = "") {
  if (!isNativeApp()) return;
  void (playing ? KeepAlive.start({ title: title || "Yfitops", text }) : KeepAlive.stop()).catch(() => {});
}

/** Botões da notificação "tocando" (ex.: "Pausar"). */
export function onNativeAction(cb: (action: string) => void) {
  if (isNativeApp()) void KeepAlive.addListener("action", (e) => cb(e.action)).catch(() => {});
}

/** Durante um download para a fila: Wi-Fi e processador acordados mesmo com a tela desligada. */
export function holdAwake(on: boolean) {
  if (!isNativeApp()) return;
  void KeepAlive.busy({ on }).catch(() => {});
}

/** Identificação deste aparelho na fila (fica guardada; não diz nada sobre a pessoa). */
export function deviceId(): string {
  const key = "yfitops.device";
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return "sem-armazenamento";
  }
}

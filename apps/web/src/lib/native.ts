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

/** O que está tocando, para os controles do sistema (carro, fone, tela bloqueada). */
export interface NowPlaying {
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  /** Segundos. */
  position: number;
  duration: number;
}

interface KeepAlivePlugin {
  /** Mantém o app vivo com a tela desligada enquanto toca (notificação "Tocando"). App antigo (build 1). */
  start(opts: { title: string; text: string }): Promise<void>;
  /** Player de música do Android (MediaSession): o carro e o fone controlam o Yfitops. Desde o build 2. */
  media(opts: NowPlaying): Promise<void>;
  /** Versão (versionCode) do app instalado. Desde o build 2. */
  version(): Promise<{ build: number }>;
  stop(): Promise<void>;
  /** Segura o Wi-Fi e o processador acordados durante um download. */
  busy(opts: { on: boolean }): Promise<void>;
  /** Celular ajudante (24 horas): app vivo, Wi-Fi e processador acordados mesmo sem música. Desde o build 4. */
  helper(opts: { on: boolean }): Promise<void>;
  /** "play", "pause", "next", "prev" ou "seek:<segundos>" (notificação, carro, fone, tela bloqueada). */
  addListener(event: "action", cb: (e: { action: string }) => void): Promise<{ remove: () => Promise<void> }>;
}

const KeepAlive = registerPlugin<KeepAlivePlugin>("YfitopsKeepAlive");

/**
 * Versão do app Android que o site espera. Suba junto com o versionCode do APK
 * quando a parte nativa mudar: quem tiver um app mais antigo é avisado para instalar o novo.
 */
export const NATIVE_BUILD = 4;

/** Versão do app Android instalado (0 = não é o app; 1 = app antigo, sem `version`). */
export async function nativeBuild(): Promise<number> {
  if (!isNativeApp()) return 0;
  try {
    return (await KeepAlive.version()).build;
  } catch {
    return 1;
  }
}

/** App antigo (build 1): só mantém vivo, sem player de música no sistema. */
let legacy = false;

/**
 * O que está tocando, para o Android (null = parou de vez). Com música na fila, o
 * Yfitops fica registrado como o player do celular, inclusive pausado: assim o
 * "play" do carro ou do fone volta a tocar.
 */
export function nowPlaying(np: NowPlaying | null) {
  if (!isNativeApp()) return;
  if (!np) {
    void KeepAlive.stop().catch(() => {});
    return;
  }
  if (legacy) {
    void (np.playing ? KeepAlive.start({ title: np.title || "Yfitops", text: np.artist }) : KeepAlive.stop()).catch(() => {});
    return;
  }
  void KeepAlive.media(np).catch(() => {
    // App antigo: não tem o player de música; mantém só o "app vivo" de antes.
    legacy = true;
    nowPlaying(np);
  });
}

/** Comandos do sistema: notificação, carro, fone Bluetooth, tela bloqueada. */
export function onNativeAction(cb: (action: string) => void) {
  if (isNativeApp()) void KeepAlive.addListener("action", (e) => cb(e.action)).catch(() => {});
}

/** Durante um download para a fila: Wi-Fi e processador acordados mesmo com a tela desligada. */
export function holdAwake(on: boolean) {
  if (!isNativeApp()) return;
  void KeepAlive.busy({ on }).catch(() => {});
}

/** Liga ou desliga o modo "celular ajudante" na parte nativa (app antigo: não faz nada). */
export function nativeHelper(on: boolean) {
  if (!isNativeApp()) return;
  void KeepAlive.helper({ on }).catch(() => {});
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

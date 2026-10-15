import { createStore } from "./observable";

// Preferências deste aparelho (tema, tamanho do texto, transição, avisos).
// Ficam no localStorage: são do aparelho, não da conta.

export type Theme = "system" | "dark" | "light";
export type TextSize = "normal" | "large" | "larger";

export interface Prefs {
  theme: Theme;
  textSize: TextSize;
  /** Segundos de transição suave entre músicas (0 = desligada). */
  crossfade: number;
  /** Avisar quando uma importação/envio terminar com o app em segundo plano. */
  notify: boolean;
  /** App Android: ajudar a baixar as músicas pedidas por link (só no Wi-Fi). */
  helpDownloads: boolean;
  /** Limite do cache de músicas ouvidas, em MB (tocar de novo não usa a internet nem o servidor). */
  cacheMB: number;
}

const DEFAULTS: Prefs = {
  theme: "system",
  textSize: "normal",
  crossfade: 0,
  notify: true,
  helpDownloads: true,
  cacheMB: 1024,
};
const KEY = "prefs";

/** O cache guarda no mínimo 1 GB: menos que isso, a mesma música seria pedida ao servidor toda hora. */
export const MIN_CACHE_MB = 1024;

function load(): Prefs {
  try {
    const p: Prefs = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    return { ...p, cacheMB: Math.max(MIN_CACHE_MB, Number(p.cacheMB) || MIN_CACHE_MB) };
  } catch {
    return DEFAULTS;
  }
}

export const prefsStore = createStore<Prefs>(load());

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  prefsStore.set((p) => ({ ...p, [key]: value }));
  try {
    localStorage.setItem(KEY, JSON.stringify(prefsStore.get()));
  } catch {
    /* sem armazenamento (aba anônima): vale só nesta sessão */
  }
  applyPrefs();
}

const SCALE: Record<TextSize, string> = { normal: "100%", large: "112.5%", larger: "125%" };
const darkQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

/** Tema efetivo: "system" segue o aparelho. */
export const resolvedTheme = (p = prefsStore.get()): "dark" | "light" =>
  p.theme === "system" ? (darkQuery?.matches === false ? "light" : "dark") : p.theme;

/** Aplica tema e tamanho do texto no <html> (e a cor da barra do navegador). */
export function applyPrefs() {
  const p = prefsStore.get();
  const theme = resolvedTheme(p);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.fontSize = SCALE[p.textSize];
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f6f5f2" : "#000000");
}

// Tema "do sistema": acompanha quando o aparelho troca de claro para escuro.
darkQuery?.addEventListener("change", () => prefsStore.get().theme === "system" && applyPrefs());

import type { Tone } from "../components/Notice";
import { createStore } from "./observable";

export const uiStore = createStore<{ editing: string | null; toast: { message: string; tone: Tone } | null; fullPlayer: boolean }>({
  editing: null,
  toast: null,
  fullPlayer: false,
});

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, tone: Tone = "ok") {
  uiStore.set((s) => ({ ...s, toast: { message, tone } }));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => uiStore.set((s) => ({ ...s, toast: null })), 2600);
}

export const openTrack = (id: string) => uiStore.set((s) => ({ ...s, editing: id }));
export const closeTrack = () => uiStore.set((s) => ({ ...s, editing: null }));

/** Executa uma ação e mostra o erro (se houver) num aviso. */
export async function attempt<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (ok) toast(ok);
    return r;
  } catch (e) {
    toast((e as Error).message || "Algo deu errado", "error");
    return undefined;
  }
}

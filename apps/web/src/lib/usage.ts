import { api } from "./api";
import { createStore } from "./observable";

/** Espaço usado na nuvem (o servidor soma os arquivos da conta). */
export interface CloudUsage {
  bytes: number;
  quota: number;
  count: number;
}

export const usageStore = createStore<CloudUsage | null>(null);

/** Busca de novo no servidor (ao abrir Ajustes/Enviar e depois de cada leva de envios). */
export async function refreshUsage() {
  try {
    usageStore.set(await api.json<CloudUsage>("/blobs"));
  } catch {
    /* offline: mantém o último valor conhecido */
  }
}

/** "ok" até 80%, "warn" até 95%, "error" acima. */
export function usageTone(u: CloudUsage): "ok" | "warn" | "error" {
  const used = u.bytes / u.quota;
  return used >= 0.95 ? "error" : used >= 0.8 ? "warn" : "ok";
}

import { prefsStore } from "./prefs";

// Como falar com o resolver: endereço e senha. O padrão vem do build
// (VITE_RESOLVER_URL); cada aparelho pode trocar em Ajustes. A senha fica só
// no aparelho, nunca no código publicado.

export const DEFAULT_RESOLVER =
  (import.meta.env.VITE_RESOLVER_URL as string | undefined) ??
  "http://127.0.0.1:8788";

/** Endereço em uso, sem "/" no fim. */
export function resolverUrl(): string {
  return (prefsStore.get().resolverUrl.trim() || DEFAULT_RESOLVER).replace(/\/+$/, "");
}

/** `fetch` no resolver, já com a senha (se houver). */
export function resolverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = prefsStore.get().resolverToken.trim();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${resolverUrl()}${path}`, { ...init, headers });
}

export type ResolverStatus = "ok" | "auth" | "offline";

/** Testa o resolver: ligado e com a senha certa? */
export async function checkResolver(): Promise<ResolverStatus> {
  try {
    const r = await resolverFetch("/health");
    if (!r.ok) return "offline";
    const b = (await r.json()) as { authorized?: boolean };
    return b.authorized === false ? "auth" : "ok";
  } catch {
    return "offline";
  }
}

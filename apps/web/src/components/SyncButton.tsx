import { libraryStore, sync } from "../lib/library";
import { useStore } from "../lib/observable";
import { Icon } from "./Icon";

const plural = (n: number) => `${n} ${n === 1 ? "alteração" : "alterações"}`;

/**
 * Estado do sync com o servidor, e um toque para sincronizar agora.
 * Tudo é salvo no aparelho primeiro; sem servidor, as alterações esperam na fila
 * e sobem sozinhas quando ele voltar.
 */
export function SyncButton() {
  const lib = useStore(libraryStore);
  const state = lib.syncing ? "syncing" : lib.offline ? "offline" : lib.error ? "error" : lib.pending ? "pending" : "ok";
  const label = {
    syncing: "sincronizando…",
    offline: lib.pending ? `offline · ${plural(lib.pending)} no aparelho` : "offline",
    error: "erro no sync · tentar de novo",
    pending: `${plural(lib.pending)} para enviar`,
    ok: "sincronizado",
  }[state];
  const title = {
    syncing: "Enviando e recebendo alterações do servidor",
    offline: "Sem conexão com o servidor. Tudo continua salvo no aparelho e sobe sozinho quando ele voltar. Toque para tentar agora.",
    error: lib.error ?? "",
    pending: "Toque para enviar agora",
    ok: lib.lastSync ? `Última sincronização: ${new Date(lib.lastSync).toLocaleTimeString()}` : "Tudo em dia com o servidor",
  }[state];

  return (
    <button className={`sync-btn ${state}`} onClick={() => void sync()} disabled={lib.syncing} title={title}>
      <Icon name={state === "ok" ? "check" : "cloud"} size={16} />
      {label}
    </button>
  );
}

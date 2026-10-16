import { TOO_LONG, type ImportOpts, type ImportRequestInfo, type ImportTrackInfo, type ResolvedTrack } from "@yfitops/core";
import { api } from "./api";
import { addSong, songTrackId } from "./catalog";
import { createPlaylist, libraryStore, saveItem } from "./library";
import { notify } from "./notify";
import { createStore } from "./observable";
import { attempt, toast } from "./ui";

// ---------------------------------------------------------------------------
// Importar por link (YouTube, Spotify, Deezer) — o lado de quem pede.
//
// O pedido vai para uma fila no servidor. Quem baixa é um celular Android com
// o app aberto (ou tocando música) e no Wi-Fi — pode ser o seu ou o de outra
// pessoa. Conforme as músicas ficam prontas, elas entram SÓ na sua biblioteca
// (quem baixou não fica com elas). Era uma playlist? No fim, vira uma playlist
// no app com o mesmo nome.
// ---------------------------------------------------------------------------

export interface ImportsState {
  /** O que está digitado no campo (sobrevive à troca de tela). */
  link: string;
  /** Tags opcionais para todas as músicas do link. */
  tags: string[];
  /** Link de um vídeo dentro de um mix/playlist: esperando "só esta" ou "a lista toda". */
  pick: { mix: boolean } | null;
  /** Link de playlist: esperando se as músicas ficam ligadas a uma playlist do app. */
  ask: boolean;
  sending: boolean;
  error: string;
  /** Seus pedidos (os que ainda não terminaram, e os que terminaram com falhas). */
  requests: ImportRequestInfo[];
  /** Celulares ajudando agora. */
  helpers: number;
  loaded: boolean;
}

export const importsStore = createStore<ImportsState>({
  link: "",
  tags: [],
  pick: null,
  ask: false,
  sending: false,
  error: "",
  requests: [],
  helpers: 0,
  loaded: false,
});
const patch = (p: Partial<ImportsState>) => importsStore.set((s) => ({ ...s, ...p }));

export const setImportLink = (link: string) => patch({ link, error: "" });
export const setImportTags = (tags: string[]) => patch({ tags });

// ---------------- Links ----------------

const hostIs = (text: string, re: RegExp) => {
  try {
    return re.test(new URL(text.trim()).hostname);
  } catch {
    return false;
  }
};
export const isYouTubeLink = (t: string) => hostIs(t, /(^|\.)(youtube\.com|youtu\.be)$/i);
export const isSpotifyLink = (t: string) => hostIs(t, /(^|\.)(spotify\.com|spotify\.link)$/i);
export const isDeezerLink = (t: string) => hostIs(t, /(^|\.)(deezer\.com|deezer\.page\.link|dzr\.page\.link)$/i);
export const isImportLink = (t: string) => isYouTubeLink(t) || isSpotifyLink(t) || isDeezerLink(t);

/**
 * Link do YouTube de um vídeo DENTRO de uma lista (watch?v=X&list=Y), o que
 * acontece ao abrir uma música a partir de um mix ou playlist.
 */
export function videoInList(text: string): { single: string; mix: boolean } | null {
  if (!isYouTubeLink(text)) return null;
  try {
    const u = new URL(text.trim());
    const v = /(^|\.)youtu\.be$/i.test(u.hostname) ? u.pathname.slice(1) : u.searchParams.get("v");
    const list = u.searchParams.get("list");
    if (!v || !list) return null;
    return { single: `https://www.youtube.com/watch?v=${v}`, mix: list.startsWith("RD") };
  } catch {
    return null;
  }
}

/** O link é de uma lista (playlist, álbum, mix)? Os curtos (spotify.link...) não dá para saber: conta como lista. */
function looksLikeList(text: string): boolean {
  try {
    const u = new URL(text.trim());
    if (isYouTubeLink(text)) return u.searchParams.has("list");
    if (/(^|\.)(spotify\.link|deezer\.page\.link|dzr\.page\.link)$/i.test(u.hostname)) return true;
    return /\/(playlist|album)\//.test(u.pathname);
  } catch {
    return false;
  }
}

const SERVICES: Record<string, string> = { youtube: "YouTube", spotify: "Spotify", deezer: "Deezer" };
export const serviceName = (url: string) => (isSpotifyLink(url) ? "Spotify" : isDeezerLink(url) ? "Deezer" : "YouTube");
export const providerName = (p?: string) => SERVICES[p ?? ""] ?? "YouTube";

/**
 * Link para ler de novo uma playlist importada (para "sincronizar"). Usa o link
 * guardado; nas importadas antes de guardarmos o link, monta pela origem.
 */
export function playlistSyncUrl(p: { source?: string; sourceUrl?: string }): string | undefined {
  if (p.sourceUrl) return p.sourceUrl;
  const m = p.source?.match(/^(youtube|spotify|deezer)-playlist:(.+)$/);
  if (!m) return undefined;
  const [, provider, id] = m;
  if (provider === "spotify") return `https://open.spotify.com/playlist/${id}`;
  if (provider === "deezer") {
    const [type, num] = id.split("-");
    return `https://www.deezer.com/${type}/${num}`;
  }
  // Mix do YouTube ("RD" + vídeo) só abre pelo endereço do vídeo.
  return /^RD[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id.slice(2)}&list=${id}` : `https://www.youtube.com/playlist?list=${id}`;
}

// ---------------- Pedir ----------------

let answerPick: ((choice: "one" | "all" | null) => void) | null = null;
let answerAsk: ((link: boolean | null) => void) | null = null;

/** Responde "só esta música" / "a lista toda". */
export function answerLinkPick(choice: "one" | "all" | null) {
  answerPick?.(choice);
  answerPick = null;
  patch({ pick: null });
}

/** Responde se as músicas ficam ligadas a uma playlist no app (null = cancelou). */
export function answerLinkAsk(link: boolean | null) {
  answerAsk?.(link);
  answerAsk = null;
  patch({ ask: false });
}

/** Manda o link do campo para a fila. */
export async function requestLink() {
  const { link, tags, sending } = importsStore.get();
  let url = link.trim();
  if (!url || sending) return;
  if (!isImportLink(url)) return patch({ error: "Cole um link do YouTube, do Spotify ou do Deezer" });
  // Vídeo dentro de um mix/playlist: só esta música ou a lista toda?
  const both = videoInList(url);
  if (both) {
    const choice = await new Promise<"one" | "all" | null>((resolve) => {
      answerPick = resolve;
      patch({ pick: { mix: both.mix } });
    });
    if (!choice) return;
    if (choice === "one") url = both.single;
  }
  let playlist = false;
  if (looksLikeList(url)) {
    const answer = await new Promise<boolean | null>((resolve) => {
      answerAsk = resolve;
      patch({ ask: true });
    });
    if (answer === null) return;
    playlist = answer;
  }
  patch({ sending: true, error: "" });
  try {
    await api.json("/imports", { method: "POST", json: { url, opts: { tags, playlist } satisfies ImportOpts } });
    patch({ link: "", tags: [] });
    toast("Pedido na fila.");
    await refreshImports();
  } catch (e) {
    patch({ error: (e as Error).message });
  } finally {
    patch({ sending: false });
  }
}

/** Sincroniza uma playlist importada: pede o link de origem de novo (só as novas são baixadas). */
export async function syncPlaylist(playlistId: string) {
  const p = libraryStore.get().playlists[playlistId];
  const url = p && playlistSyncUrl(p);
  if (!url) return;
  if (importsStore.get().requests.some((r) => r.url === url && !finished(r))) return toast("Essa playlist já está na fila");
  await attempt(async () => {
    await api.json("/imports", { method: "POST", json: { url, opts: { tags: [], playlist: true } satisfies ImportOpts } });
    await refreshImports();
  }, "Sincronização pedida: as músicas novas entram na playlist quando ficarem prontas");
}

// ---------------- Acompanhar e receber ----------------

/** O pedido terminou (nada mais na fila nem baixando)? */
/** Quantas foram ignoradas por passar de 13 minutos. */
const tooLong = (r: ImportRequestInfo) => r.tracks.filter((t) => t.status === "skipped" && t.error === TOO_LONG).length;

export const finished = (r: ImportRequestInfo) =>
  r.status === "failed" || (r.status === "listed" && !r.tracks.some((t) => t.status === "queued" || t.status === "working"));

/** Situação de um pedido em uma linha ("4 de 12 prontas · 1 baixando agora"). */
export function requestProgress(r: ImportRequestInfo): string {
  if (r.status === "queued") return "na fila, esperando para ser baixado";
  if (r.status === "listing") return "lendo o link…";
  if (r.status === "failed") return r.error ?? "o link não pôde ser lido";
  const count = (s: string) => r.tracks.filter((t) => t.status === s).length;
  const now = r.tracks.find((t) => t.status === "working");
  return [
    `${count("done")} de ${r.tracks.length} prontas`,
    now ? `baixando “${now.meta.title}”` : count("queued") && "na fila, esperando para ser baixado",
    count("failed") && `${count("failed")} não deram`,
    tooLong(r) && `${tooLong(r)} com mais de 13 minutos (não entram)`,
    count("skipped") - tooLong(r) && `${count("skipped") - tooLong(r)} ignoradas`,
  ]
    .filter(Boolean)
    .join(" · ");
}

const openRequests = () =>importsStore.get().requests.some((r) => !finished(r));

const catalogKey = (t: ResolvedTrack) => (t.spotifyId ? `spotify:${t.spotifyId}` : t.deezerId ? `deezer:${t.deezerId}` : undefined);

let refreshing: Promise<void> | null = null;

/** Busca seus pedidos e põe na biblioteca as músicas que ficaram prontas. */
export function refreshImports(): Promise<void> {
  refreshing ??= (async () => {
    try {
      const { requests, helpers } = await api.json<{ requests: ImportRequestInfo[]; helpers: number }>("/imports");
      patch({ helpers, loaded: true });
      const keep: ImportRequestInfo[] = [];
      for (const r of requests) if (!(await deliver(r))) keep.push(r);
      patch({ requests: keep });
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Entrega o que ficou pronto. Devolve true se o pedido acabou sem falhas (e saiu da fila). */
async function deliver(r: ImportRequestInfo): Promise<boolean> {
  const fresh = r.tracks.filter((t) => t.status === "done" && t.song && !t.delivered);
  for (const t of fresh) {
    const key = catalogKey(t.meta);
    await addSong(t.song!, {
      tags: r.opts.tags,
      source: t.meta.videoId ? `youtube:${t.meta.videoId}` : undefined,
      alsoFrom: key ? [key] : undefined,
    });
  }
  if (fresh.length) {
    await api.json(`/imports/${r.id}/delivered`, { method: "POST", json: { tracks: fresh.map((t) => t.id) } }).catch(() => {});
    for (const t of fresh) t.delivered = true;
  }
  if (!finished(r)) return false;
  // Era uma playlist: tudo (o que já estava e o que chegou) numa playlist do app com o mesmo nome.
  const done = r.tracks.filter((t) => t.status === "done" && t.song);
  let playlistId: string | undefined;
  if (r.opts.playlist && r.source && done.length > 1) {
    playlistId = await linkPlaylist(r.source, r.name || `Playlist do ${providerName(r.provider)}`, done, r.url);
  }
  const failed = r.tracks.filter((t) => t.status === "failed").length;
  const long = tooLong(r);
  if (fresh.length || long || r.status === "failed") {
    const where = playlistId ? ` em ${libraryStore.get().playlists[playlistId]?.name}` : "";
    void notify(
      failed || r.status === "failed" ? "Importação terminou com falhas" : "Importação concluída",
      r.status === "failed" ? (r.error ?? "O link não pôde ser lido") : [`${done.length} música(s)${where}`, failed && `${failed} não puderam ser baixadas`, long && `${long} com mais de 13 minutos ficaram de fora`].filter(Boolean).join(" · "),
    );
  }
  // Com falha ou com música longa demais: o card fica, para a pessoa ver o motivo (e dispensar).
  if (failed || long || r.status === "failed") return false;
  await api.json(`/imports/${r.id}`, { method: "DELETE" }).catch(() => {});
  return true;
}

/**
 * Cria (ou atualiza, se já foi importada antes) a playlist do app ligada à
 * playlist de origem, na ordem original. As que a pessoa pôs à mão continuam, no fim.
 */
async function linkPlaylist(source: string, name: string, tracks: ImportTrackInfo[], sourceUrl: string): Promise<string | undefined> {
  const lib = libraryStore.get();
  const ids = [...new Set(tracks.map((t) => songTrackId(t.song!.id)).filter((id) => lib.tracks[id]))];
  const found = Object.entries(lib.playlists).find(([, p]) => p.source === source);
  if (found) {
    const [pid, p] = found;
    const extra = p.trackIds.filter((x) => !ids.includes(x));
    const trackIds = [...ids, ...extra];
    if (trackIds.join() !== p.trackIds.join() || p.sourceUrl !== sourceUrl) await saveItem("playlist", pid, { ...p, trackIds, sourceUrl, syncedAt: Date.now() });
    return pid;
  }
  if (!ids.length) return undefined;
  const pid = await createPlaylist(name, ids);
  await saveItem("playlist", pid, { ...libraryStore.get().playlists[pid], source, sourceUrl, syncedAt: Date.now() });
  return pid;
}

/** Ignora músicas que ainda não foram baixadas. */
export const skipTracks = (r: ImportRequestInfo, ids: string[]) =>
  attempt(async () => {
    await api.json(`/imports/${r.id}/skip`, { method: "POST", json: { tracks: ids } });
    await refreshImports();
  });

/** Tenta de novo as que falharam (e as ignoradas). */
export const retryRequest = (r: ImportRequestInfo) =>
  attempt(async () => {
    await api.json(`/imports/${r.id}/retry`, { method: "POST", json: {} });
    await refreshImports();
  }, "De volta para a fila");

/** Cancela o pedido (o que já chegou fica na biblioteca) ou tira da lista. */
export const dropRequest = (r: ImportRequestInfo) =>
  attempt(async () => {
    // Antes, recebe o que já ficou pronto (pode até terminar e sair sozinho).
    await refreshImports().catch(() => {});
    if (!importsStore.get().requests.some((x) => x.id === r.id)) return;
    await api.json(`/imports/${r.id}`, { method: "DELETE" });
    patch({ requests: importsStore.get().requests.filter((x) => x.id !== r.id) });
  });

let polling: ReturnType<typeof setInterval> | undefined;

const onVisible = () => {
  if (document.visibilityState === "visible" && (openRequests() || !importsStore.get().loaded)) void refreshImports().catch(() => {});
};

/**
 * Acompanha os pedidos: ao abrir o app e, enquanto houver pedido em aberto, a
 * cada 20 s com o app na tela (fechado, o pedido continua na fila do servidor).
 */
export function watchImports() {
  void refreshImports().catch(() => {});
  clearInterval(polling);
  polling = setInterval(() => {
    if (document.visibilityState === "visible" && openRequests()) void refreshImports().catch(() => {});
  }, 20_000);
  document.addEventListener("visibilitychange", onVisible);
}

export function stopImports() {
  clearInterval(polling);
  document.removeEventListener("visibilitychange", onVisible);
  patch({ requests: [], loaded: false });
}

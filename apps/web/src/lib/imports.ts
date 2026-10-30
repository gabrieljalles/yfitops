import { MAX_SONG_SECONDS, TOO_LONG, TOO_LONG_LOCAL, type ImportOpts, type ImportRequestInfo, type ImportTrackInfo, type ResolvedTrack, type TrackSearchHit } from "@yfitops/core";
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
// pessoa. O seu também baixa os seus pedidos nos dados móveis, com o app aberto. Conforme as músicas ficam prontas, elas entram SÓ na sua biblioteca
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
  /** Busca pelo nome da música: resultados (null = nenhuma busca feita) e o texto buscado. */
  results: TrackSearchHit[] | null;
  resultsFor: string;
  searching: boolean;
  /** Resultados já pedidos (o botão vira "pedida"). */
  requested: string[];
  /** Músicas que acabaram de chegar (o aviso "chegou" fica um tempo na tela). */
  arrived: Arrived[];
}

/** Uma música pedida que acabou de entrar na biblioteca. */
export interface Arrived {
  trackId: string;
  title: string;
  artist: string;
  at: number;
}

/** Por quanto tempo o aviso "chegou" fica na tela. */
const ARRIVED_FOR = 15 * 60_000;

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
  results: null,
  resultsFor: "",
  searching: false,
  requested: [],
  arrived: [],
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
/** O campo tem um nome de música (e não um link)? */
export const isSearchText = (t: string) => t.trim().length >= 2 && !/^https?:\/\//i.test(t.trim()) && !/^[\w-]+(\.[\w-]+)+\//.test(t.trim());

/** Busca pelo nome no campo: mostra as músicas para a pessoa escolher qual pedir. */
export async function searchTracks() {
  const q = importsStore.get().link.trim();
  if (!isSearchText(q) || importsStore.get().searching) return;
  patch({ searching: true, error: "" });
  try {
    const { tracks } = await api.json<{ tracks: TrackSearchHit[] }>(`/search/tracks?q=${encodeURIComponent(q)}`);
    // Saiu do Descobrir (o campo foi limpo) antes de a busca responder: não mostra nada.
    if (importsStore.get().link.trim() === q) patch({ results: tracks, resultsFor: q });
  } catch (e) {
    if (importsStore.get().link.trim() === q) patch({ error: (e as Error).message });
  } finally {
    patch({ searching: false });
  }
}

/** Pede uma música achada na busca (vai para a fila como um link do Deezer). */
export async function requestTrack(hit: TrackSearchHit) {
  const { tags, requested } = importsStore.get();
  if (requested.includes(hit.id)) return;
  patch({ requested: [...requested, hit.id] });
  try {
    await api.json("/imports", { method: "POST", json: { url: hit.url, opts: { tags, playlist: false } satisfies ImportOpts } });
    toast(`Pedido na fila: ${hit.title}`);
    await refreshImports();
  } catch (e) {
    patch({ requested: importsStore.get().requested.filter((id) => id !== hit.id) });
    toast((e as Error).message, "error");
  }
}

/** Fecha os resultados da busca. */
export const clearSearch = () => patch({ results: null, resultsFor: "" });

/**
 * Saiu do Descobrir: na volta, ele começa do zero (campo vazio, sem busca nem tags).
 * Só não limpa no meio de um pedido ou de uma pergunta sobre o link ("criar a
 * playlist?"), que ainda precisam do link digitado.
 */
export function resetDiscover() {
  const s = importsStore.get();
  if (s.sending || s.ask || s.pick) return;
  patch({ link: "", error: "", tags: [], results: null, resultsFor: "" });
}

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
  // Não é link: é o nome de uma música. Busca e deixa a pessoa escolher.
  if (!isImportLink(url)) {
    if (isSearchText(url)) return void searchTracks();
    return patch({ error: "Cole um link do YouTube, do Spotify ou do Deezer, ou digite o nome da música" });
  }
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

/** Quantas ficaram de fora por passar de 13 minutos. */
const tooLong = (r: ImportRequestInfo) => r.tracks.filter((t) => t.status === "skipped" && t.error === TOO_LONG).length;
/** Quantas passaram de 13 minutos e ficaram só no seu celular. */
const keptLocal = (r: ImportRequestInfo) => r.tracks.filter((t) => t.status === "skipped" && t.error === TOO_LONG_LOCAL).length;
/** Na fila, mas com mais de 13 minutos: só o seu celular Android pode baixar. */
export const waitsForMyPhone = (t: ImportTrackInfo) => t.status === "queued" && (t.meta.duration ?? 0) > MAX_SONG_SECONDS;

/** O pedido terminou (nada mais na fila nem baixando)? */
export const finished = (r: ImportRequestInfo) =>
  r.status === "failed" || (r.status === "listed" && !r.tracks.some((t) => t.status === "queued" || t.status === "working"));

/** Situação de um pedido em uma linha ("4 de 12 prontas · 1 baixando agora"). */
export function requestProgress(r: ImportRequestInfo): string {
  if (r.status === "queued") return "na fila, esperando para ser baixado";
  if (r.status === "listing") return "lendo o link…";
  if (r.status === "failed") return r.error ?? "o link não pôde ser lido";
  const count = (s: string) => r.tracks.filter((t) => t.status === s).length;
  const now = r.tracks.find((t) => t.status === "working");
  const mine = r.tracks.filter(waitsForMyPhone).length;
  const local = keptLocal(r);
  return [
    `${count("done")} de ${r.tracks.length} prontas`,
    now ? `baixando “${now.meta.title}”` : count("queued") > mine && "na fila, esperando para ser baixado",
    mine && `${mine} com mais de 13 minutos esperando o seu celular Android (fica só nele)`,
    local && `${local} com mais de 13 minutos ficou só no seu celular`,
    count("failed") && `${count("failed")} não deram`,
    tooLong(r) && `${tooLong(r)} com mais de 13 minutos (não entram)`,
    count("skipped") - tooLong(r) - local && `${count("skipped") - tooLong(r) - local} ignoradas`,
  ]
    .filter(Boolean)
    .join(" · ");
}

const openRequests = () => importsStore.get().requests.some((r) => !finished(r));

/** Tira o aviso "chegou" de uma música (ou de todas). */
export const dismissArrived = (trackId?: string) =>
  patch({ arrived: trackId ? importsStore.get().arrived.filter((a) => a.trackId !== trackId) : [] });

/**
 * Quanto de uma música pedida já andou (0 a 100). Na fila fica em 3 (a barra
 * aparece); baixando, vem do celular que baixa; pronta, 100.
 */
export function trackPercent(t: ImportTrackInfo): number {
  if (t.status === "done") return 100;
  if (t.status === "working") return Math.max(8, Math.min(97, t.progress ?? 0));
  return 3;
}

/** Quanto do pedido já andou (0 a 100), contando só as músicas que vão chegar. */
export function requestPercent(r: ImportRequestInfo): number {
  if (r.status === "queued") return 2;
  if (r.status === "listing") return 5;
  const live = r.tracks.filter((t) => t.status !== "failed" && t.status !== "skipped");
  if (!live.length) return 100;
  return Math.round(live.reduce((n, t) => n + trackPercent(t), 0) / live.length);
}

/** Em que pé está, em poucas palavras: "Na fila", "Baixando", "Quase pronta"... */
export function requestStage(r: ImportRequestInfo, helpers: number): { label: string; hint: string; working: boolean } {
  if (r.status === "failed") return { label: "Não deu certo", hint: r.error ?? "O link não pôde ser lido", working: false };
  const working = r.status === "listing" || r.tracks.some((t) => t.status === "working");
  if (working) {
    const pct = requestPercent(r);
    return { label: pct >= 75 ? "Quase pronta" : "Baixando", hint: "Sua música está sendo baixada.", working: true };
  }
  if (!finished(r))
    return {
      label: "Na fila",
      hint: helpers ? "Sua música vai começar a baixar em instantes." : "Sua música vai baixar em breve. Pode fechar o app: ela chega sozinha.",
      working: false,
    };
  return { label: "Pronta", hint: "Já está na sua biblioteca.", working: false };
}

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
  const arrived: Arrived[] = [];
  for (const t of fresh) {
    const key = catalogKey(t.meta);
    const { id } = await addSong(t.song!, {
      tags: r.opts.tags,
      source: t.meta.videoId ? `youtube:${t.meta.videoId}` : undefined,
      alsoFrom: key ? [key] : undefined,
    });
    arrived.push({ trackId: id, title: t.song!.title, artist: t.song!.artist, at: Date.now() });
  }
  if (arrived.length) {
    const recent = importsStore.get().arrived.filter((a) => Date.now() - a.at < ARRIVED_FOR);
    patch({ arrived: [...arrived.reverse(), ...recent].slice(0, 20) });
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
  const local = keptLocal(r);
  if (fresh.length || long || local || r.status === "failed") {
    const where = playlistId ? ` em ${libraryStore.get().playlists[playlistId]?.name}` : "";
    void notify(
      failed || r.status === "failed" ? "Importação terminou com falhas" : "Importação concluída",
      r.status === "failed" ? (r.error ?? "O link não pôde ser lido") : [`${done.length} música(s)${where}`, failed && `${failed} não puderam ser baixadas`, long && `${long} com mais de 13 minutos ficaram de fora`, local && `${local} com mais de 13 minutos ficou só no seu celular`].filter(Boolean).join(" · "),
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
 * Acompanha os pedidos: ao abrir o app e, enquanto houver pedido em aberto, com o
 * app na tela: a cada 6 s se algum está baixando (a barra anda), senão a cada 20 s.
 * Fechado, o pedido continua na fila do servidor.
 */
export function watchImports() {
  void refreshImports().catch(() => {});
  clearInterval(polling);
  let last = 0;
  polling = setInterval(() => {
    if (document.visibilityState !== "visible" || !openRequests()) return;
    const busy = importsStore.get().requests.some((r) => r.status === "listing" || r.tracks.some((t) => t.status === "working"));
    if (Date.now() - last < (busy ? 6_000 : 20_000)) return;
    last = Date.now();
    void refreshImports().catch(() => {});
  }, 2_000);
  document.addEventListener("visibilitychange", onVisible);
}

export function stopImports() {
  clearInterval(polling);
  document.removeEventListener("visibilitychange", onVisible);
  patch({ requests: [], loaded: false, arrived: [] });
}

import { artistFromChannel, splitArtistTitle } from "./artist";
import { ACCEPTED_EXT, enqueue, trackIdBySource } from "./importer";
import { createPlaylist, libraryStore, saveItem } from "./library";
import { mergeTags } from "./search";

// ---------------------------------------------------------------------------
// Importar playlist do YouTube e do Spotify.
//
// O app fala com o "resolver" (servidor Node separado), que devolve:
//   1) a lista de faixas da playlist;
//   2) para cada faixa, a URL do áudio.
//
// No Spotify, o resolver usa a API oficial só para LER a lista (nome, artista,
// álbum). O áudio do Spotify é protegido por DRM e não é acessível, então cada
// faixa é procurada no YouTube por texto ("artista - música") e baixada de lá —
// o mesmo que ferramentas como o spotdl fazem.
//
// Depois de baixado, o áudio vira um `File` e entra no `enqueue` — o MESMO
// caminho de quando você arrasta arquivos. Dedupe, conversão, criptografia e
// upload continuam por conta do pipeline que já existe.
//
// Configure com VITE_RESOLVER_URL (ex.: http://127.0.0.1:8788).
// ---------------------------------------------------------------------------

const RESOLVER =
  (import.meta.env.VITE_RESOLVER_URL as string | undefined) ??
  "http://127.0.0.1:8788";

/** O texto é um link do YouTube? (mesma regra de hosts do resolver.) */
export function isYouTubeLink(text: string): boolean {
  try {
    return /(^|\.)(youtube\.com|youtu\.be)$/i.test(
      new URL(text.trim()).hostname,
    );
  } catch {
    return false;
  }
}

/** O texto é um link do Spotify? */
export function isSpotifyLink(text: string): boolean {
  try {
    return /(^|\.)(spotify\.com|spotify\.link)$/i.test(
      new URL(text.trim()).hostname,
    );
  } catch {
    return false;
  }
}

/**
 * Link do YouTube que aponta para um vídeo DENTRO de uma lista (watch?v=X&list=Y),
 * o que acontece ao abrir uma música a partir de um mix ou playlist. Devolve o
 * link só do vídeo e se a lista é um mix (gerado pelo YouTube, "RD..."); senão, null.
 */
export function videoInList(text: string): { single: string; mix: boolean } | null {
  if (!isYouTubeLink(text)) return null;
  try {
    const u = new URL(text.trim());
    // youtu.be/<id>?list=... traz o vídeo no caminho, não no ?v=.
    const v = /(^|\.)youtu\.be$/i.test(u.hostname) ? u.pathname.slice(1) : u.searchParams.get("v");
    const list = u.searchParams.get("list");
    if (!v || !list) return null;
    return { single: `https://www.youtube.com/watch?v=${v}`, mix: list.startsWith("RD") };
  } catch {
    return null;
  }
}

/** O texto é um link do Deezer (incluindo os curtos, deezer.page.link etc.)? */
export function isDeezerLink(text: string): boolean {
  try {
    return /(^|\.)(deezer\.com|deezer\.page\.link|dzr\.page\.link)$/i.test(
      new URL(text.trim()).hostname,
    );
  } catch {
    return false;
  }
}

/** Aceita YouTube, Spotify ou Deezer (habilita o botão de importar). */
export function isImportLink(text: string): boolean {
  return isYouTubeLink(text) || isSpotifyLink(text) || isDeezerLink(text);
}

/** Nome do serviço para mostrar ("Playlist do Deezer"). */
const PROVIDER_NAMES: Record<string, string> = {
  youtube: "YouTube",
  spotify: "Spotify",
  deezer: "Deezer",
};

export interface ResolvedTrack {
  videoId: string;
  title: string;
  artist: string;
  duration: number;
  /** Só nas faixas do Spotify/Deezer, enquanto ainda não foram buscadas no YouTube. */
  query?: string;
  album?: string;
  cover?: string;
  spotifyId?: string;
  deezerId?: string;
}

export interface ResolvedStream {
  videoId: string;
  streamUrl: string;
  title: string;
  /** Só quando o YouTube tem o metadado de música; senão "". */
  artist: string;
  /** Canal que publicou (nem sempre é o artista). */
  channel?: string;
}

/**
 * Falha vinda do resolver, com o motivo e se vale tentar de novo.
 * `kind`: "limit" = o YouTube está segurando os pedidos (desacelerar);
 * "gone" / "age" = não adianta insistir; "temp" = passageira; "offline" = resolver desligado.
 */
export class ResolverError extends Error {
  constructor(
    message: string,
    public kind: "limit" | "gone" | "age" | "temp" | "offline",
    public retryable: boolean,
  ) {
    super(message);
  }
}

/** A pessoa cancelou a importação antes de qualquer download começar. */
export class ImportCancelled extends Error {
  constructor() {
    super("Importação cancelada");
  }
}

const OFFLINE = () =>
  new ResolverError(
    "Não consegui falar com o servidor de importação. Ele está rodando?",
    "offline",
    false,
  );

/** Lê o erro que o resolver mandou (JSON com error/kind/retryable). */
async function errorFrom(res: Response): Promise<ResolverError> {
  try {
    const b = await res.json();
    return new ResolverError(
      b.error ?? `O servidor respondeu ${res.status}`,
      b.kind ?? "temp",
      b.retryable ?? true,
    );
  } catch {
    return new ResolverError(
      `O servidor respondeu ${res.status}`,
      "temp",
      true,
    );
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RESOLVER}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw OFFLINE();
  }
  if (!res.ok) throw await errorFrom(res);
  return res.json() as Promise<T>;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pausa entre uma música e outra: pedidos em rajada são o que mais leva a bloqueio. */
const PAUSE_BETWEEN_TRACKS = 2_000;
/** Espera ao ser limitado pelo YouTube, antes de uma última tentativa. */
const LIMIT_BACKOFF = 45_000;
/** Esperas entre tentativas quando a falha é passageira. */
const RETRY_DELAYS = [3_000, 10_000];

interface Listing {
  tracks: ResolvedTrack[];
  provider: string;
  /** ID da playlist na origem; null para vídeo/faixa solta. */
  playlist: string | null;
  name: string | null;
  /** O Spotify sem credenciais só entrega as 50 primeiras: a lista pode estar cortada. */
  truncated: boolean;
}

/** Lista as músicas de uma playlist, ou o vídeo solto (rápido, não baixa áudio ainda). */
export function listPlaylist(url: string): Promise<Listing> {
  return post<Partial<Listing> & { tracks: ResolvedTrack[] }>("/resolve", {
    url,
  }).then((r) => ({
    tracks: r.tracks,
    provider: r.provider ?? "youtube",
    playlist: r.playlist ?? null,
    name: r.name ?? null,
    truncated: r.truncated ?? false,
  }));
}

/** Obtém a URL do áudio de uma faixa. */
const resolveStream = (videoId: string) =>
  post<ResolvedStream>("/resolve/track", { videoId });

/**
 * Procura uma faixa no YouTube por texto ("artista - música"). É assim que
 * achamos o áudio das músicas do Spotify, que só trazem metadados.
 */
const searchTrack = (query: string) =>
  post<{ videoId: string; title: string; artist: string; duration: number }>(
    "/resolve/search",
    { query },
  );

const safeName = (s: string) =>
  (s || "faixa").replace(/[\\/:*?"<>|]/g, "_").trim();

/** Resultado de uma importação: o que entrou, o que já existia e o que falhou (com o motivo). */
export interface PlaylistResult {
  imported: ResolvedTrack[];
  existing: ResolvedTrack[];
  failed: { track: ResolvedTrack; reason: string }[];
  /** Músicas que a pessoa pediu para ignorar durante a importação. */
  skipped: ResolvedTrack[];
  /** Só as primeiras músicas da playlist foram lidas (limite de 50 do Spotify). */
  truncated?: boolean;
  /** Tags escolhidas na importação (o "tentar de novo" usa as mesmas). */
  tags?: string[];
  /** Playlist do app que recebeu as músicas (quando o link era de uma playlist). */
  playlist?: { id: string; name: string; source: string; tracks: ResolvedTrack[] };
}

/** Id da faixa no app para uma faixa da origem (depois de importada ou se já existia). */
const appTrackId = (t: ResolvedTrack) =>
  (t.videoId ? trackIdBySource(`youtube:${t.videoId}`) : undefined) ?? trackIdByCatalog(catalogKey(t));

/** Origem da faixa no catálogo ("spotify:<id>", "deezer:<id>"); undefined para vídeos do YouTube. */
const catalogKey = (t: ResolvedTrack) =>
  t.spotifyId ? `spotify:${t.spotifyId}` : t.deezerId ? `deezer:${t.deezerId}` : undefined;

/** Faixa da biblioteca que já veio dessa origem do catálogo (sem precisar procurar no YouTube). */
function trackIdByCatalog(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const tracks = libraryStore.get().tracks;
  return Object.keys(tracks).find((id) => tracks[id].alsoFrom?.includes(key));
}

/**
 * Atualiza uma faixa que já estava na biblioteca: recebe as tags escolhidas e
 * passa a lembrar a origem no catálogo (da próxima vez, nem procura no YouTube).
 */
async function touchExisting(id: string, tags: string[] | undefined, key: string | undefined) {
  const t = libraryStore.get().tracks[id];
  if (!t) return;
  const merged = mergeTags(t.tags, tags);
  const alsoFrom = key && !t.alsoFrom?.includes(key) ? [...(t.alsoFrom ?? []), key] : t.alsoFrom;
  if (merged !== t.tags || alsoFrom !== t.alsoFrom) await saveItem("track", id, { ...t, tags: merged, alsoFrom });
}

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
  return /^RD[\w-]{11}$/.test(id)
    ? `https://www.youtube.com/watch?v=${id.slice(2)}&list=${id}`
    : `https://www.youtube.com/playlist?list=${id}`;
}

/**
 * Cria (ou atualiza, se já foi importada antes) a playlist do app ligada à
 * playlist de origem, com as músicas na ordem original. Músicas que a pessoa
 * adicionou à mão na playlist do app continuam lá, no fim.
 */
async function linkPlaylist(
  source: string,
  name: string,
  tracks: ResolvedTrack[],
  sourceUrl?: string,
): Promise<string | undefined> {
  const ids = [...new Set(tracks.map(appTrackId).filter((x): x is string => !!x))];
  const playlists = libraryStore.get().playlists;
  const found = Object.entries(playlists).find(([, p]) => p.source === source);
  const syncedAt = Date.now();
  if (found) {
    const [pid, p] = found;
    const extra = p.trackIds.filter((x) => !ids.includes(x));
    await saveItem("playlist", pid, { ...p, trackIds: [...ids, ...extra], sourceUrl: sourceUrl ?? p.sourceUrl, syncedAt });
    return pid;
  }
  if (!ids.length) return undefined;
  const pid = await createPlaylist(name, ids);
  const created = libraryStore.get().playlists[pid];
  await saveItem("playlist", pid, { ...created, source, ...(sourceUrl && { sourceUrl }), syncedAt });
  return pid;
}

/** Vídeos sendo importados agora, para não baixar o mesmo duas vezes ao mesmo tempo. */
const inFlight = new Set<string>();

/**
 * Importa uma playlist inteira, ou uma faixa/vídeo solto (lê a lista e chama
 * `importTracks`).
 *
 * @param url    link da playlist do YouTube ou do Spotify
 * @param onNote callback de status ("3 de 20 · baixando X...")
 */
/**
 * Controle de uma importação em andamento, para a tela mostrar o que ainda vai
 * ser baixado e deixar a pessoa ignorar músicas.
 */
export interface ImportControl {
  /** A lista que vai ser importada (logo depois de lida). */
  onList?: (tracks: ResolvedTrack[]) => void;
  /** Índice da faixa em andamento (tracks.length = terminou). */
  onProgress?: (index: number) => void;
  /** A pessoa pediu para ignorar essa faixa? */
  isSkipped?: (t: ResolvedTrack) => boolean;
  /**
   * Pergunta, antes de baixar, se as músicas da playlist devem ficar ligadas a
   * uma playlist do app (true) ou entrar soltas (false). Sem isso, liga.
   */
  askLink?: (playlist: { name: string; count: number; truncated: boolean }) => Promise<boolean | null>;
  /** A pessoa cancelou antes de começar a baixar? (o null do askLink também cancela) */
  isCancelled?: () => boolean;
  /** Tags aplicadas a todas as músicas (às novas e às que já estavam na biblioteca). */
  tags?: string[];
}

export async function importPlaylist(
  url: string,
  onNote?: (note: string) => void,
  control?: ImportControl,
): Promise<PlaylistResult> {
  onNote?.("lendo o link...");
  const { tracks, provider, playlist, name, truncated } = await listPlaylist(url);
  // Cancelada enquanto lia o link: para antes de baixar qualquer coisa.
  if (control?.isCancelled?.()) throw new ImportCancelled();
  if (!tracks.length) throw new Error("Essa playlist está vazia");
  const service = PROVIDER_NAMES[provider] ?? "YouTube";
  const title = name || `Playlist do ${service}`;
  // Com uma música só, nunca liga: não vale criar uma playlist de uma música.
  let link = false;
  if (playlist && tracks.length > 1) {
    const answer = await (control?.askLink?.({ name: title, count: tracks.length, truncated }) ?? true);
    if (answer === null) throw new ImportCancelled();
    link = answer;
  }
  if (provider !== "youtube")
    onNote?.(
      `lendo a playlist do ${service}... vou procurar cada música no YouTube.`,
    );
  const result = await importTracks(tracks, onNote, control);
  if (truncated) result.truncated = true;
  if (!link) return result;

  // Era uma playlist: todas as músicas (novas e as que já existiam) entram
  // numa playlist do app com o mesmo nome, sem a pessoa precisar montar.
  const source = `${provider}-playlist:${playlist}`;
  // As ignoradas ficam de fora (e continuam de fora ao tentar de novo).
  const kept = tracks.filter((t) => !result.skipped.includes(t));
  const id = await linkPlaylist(source, title, kept, url);
  if (id) result.playlist = { id, name: libraryStore.get().playlists[id]?.name ?? title, source, tracks: kept };
  return result;
}

/**
 * Tenta de novo só as músicas que falharam e, se elas eram de uma playlist,
 * encaixa as que deram certo na playlist do app (na posição original).
 */
export async function retryFailed(
  prev: PlaylistResult,
  onNote?: (note: string) => void,
  control?: ImportControl,
): Promise<PlaylistResult> {
  const result = await importTracks(prev.failed.map((f) => f.track), onNote, { ...control, tags: prev.tags });
  if (prev.truncated) result.truncated = true;
  if (prev.playlist) {
    const { source, name } = prev.playlist;
    const tracks = prev.playlist.tracks.filter((t) => !result.skipped.includes(t));
    const id = await linkPlaylist(source, name, tracks);
    if (id) result.playlist = { ...prev.playlist, id, tracks };
  }
  return result;
}

/**
 * Para cada faixa, baixa o áudio como `File` e entrega ao importador. Uma faixa
 * por vez, para não estourar memória e para o progresso fazer sentido.
 * Vídeos que já estão na biblioteca (ou repetidos na lista) não são baixados.
 * Também serve para tentar de novo só as que falharam.
 */
export async function importTracks(
  tracks: ResolvedTrack[],
  onNote?: (note: string) => void,
  control?: ImportControl,
): Promise<PlaylistResult> {
  const tags = control?.tags?.length ? control.tags : undefined;
  const result: PlaylistResult = { imported: [], existing: [], failed: [], skipped: [], tags };
  const skipped = (t: ResolvedTrack) => control?.isSkipped?.(t) ?? false;
  control?.onList?.(tracks);
  const pending: Promise<void>[] = [];
  const seen = new Set<string>();
  let downloaded = 0;
  let limitHits = 0;
  /** Motivo para não tentar as faixas restantes (resolver desligado, YouTube limitando). */
  let stopped = "";

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const prefix = `${i + 1} de ${tracks.length}`;
    control?.onProgress?.(i);
    if (skipped(t)) {
      result.skipped.push(t);
      continue;
    }

    // Já veio desse Spotify/Deezer antes (ex.: ao sincronizar uma playlist):
    // não procura de novo no YouTube, nem baixa. Só recebe as tags.
    const key = catalogKey(t);
    const fromCatalog = trackIdByCatalog(key);
    if (fromCatalog) {
      if (tags) await touchExisting(fromCatalog, tags, undefined);
      result.existing.push(t);
      continue;
    }

    // Faixa do Spotify/Deezer: ainda não tem videoId. Procura "artista - música" no
    // YouTube e usa o melhor resultado (é o passo que o spotdl também faz).
    if (!t.videoId && t.query) {
      if (stopped) {
        result.failed.push({ track: t, reason: stopped });
        continue;
      }
      try {
        onNote?.(`${prefix} · procurando "${t.title}" no YouTube...`);
        const hit = await searchTrack(t.query);
        t.videoId = hit.videoId;
        // Prefere o título/artista do Spotify (mais limpos que os do vídeo),
        // mas aproveita os do YouTube se faltar.
        if (!t.title) t.title = hit.title;
        if (!t.artist) t.artist = hit.artist;
        if (!t.duration) t.duration = hit.duration;
      } catch (e) {
        result.failed.push({ track: t, reason: (e as Error).message });
        const kind = e instanceof ResolverError ? e.kind : "temp";
        if (kind === "offline")
          stopped = "não tentada: o servidor de importação está desligado";
        if (kind === "limit" && ++limitHits >= 2)
          stopped =
            "não tentada: o YouTube está limitando os pedidos; tente de novo daqui a alguns minutos";
        continue;
      }
    }

    const source = `youtube:${t.videoId}`;
    const known = trackIdBySource(source);
    if (seen.has(t.videoId) || inFlight.has(t.videoId) || known) {
      // Já estava na biblioteca: não baixa de novo, mas recebe as tags escolhidas
      // e passa a lembrar a origem no catálogo.
      if (known) await touchExisting(known, tags, key);
      if (!seen.has(t.videoId)) result.existing.push(t);
      seen.add(t.videoId);
      continue;
    }
    seen.add(t.videoId);
    if (stopped) {
      result.failed.push({ track: t, reason: stopped });
      continue;
    }
    inFlight.add(t.videoId);
    if (downloaded++ > 0) await wait(PAUSE_BETWEEN_TRACKS);
    // Pode ter sido ignorada durante a pausa (ou a busca no YouTube).
    if (skipped(t)) {
      inFlight.delete(t.videoId);
      result.skipped.push(t);
      continue;
    }
    try {
      onNote?.(`${prefix} · baixando "${t.title}"...`);
      const file = await downloadWithRetry(t, i, (note) =>
        onNote?.(`${prefix} · ${note}`),
      );
      limitHits = 0;
      onNote?.(`${prefix} · baixando a capa de "${t.title}"...`);
      const [job] = enqueue([file], {
        // Capa: a do Spotify (quando veio de lá) tem prioridade; senão a
        // thumbnail do vídeo no YouTube.
        cover:
          (t.cover ? await fetchCover(t.cover) : undefined) ??
          (await fetchThumbnail(t.videoId)),
        source,
        title: t.title,
        artist: t.artist,
        album: t.album,
        tags,
        alsoFrom: key ? [key] : undefined,
      });
      if (!job) throw new Error("formato não reconhecido");
      pending.push(
        job.then((j) => {
          inFlight.delete(t.videoId);
          if (j.status === "pronto") result.imported.push(t);
          else if (j.status === "já existe") result.existing.push(t);
          else
            result.failed.push({
              track: t,
              reason: j.detail || "erro ao importar",
            });
        }),
      );
    } catch (e) {
      inFlight.delete(t.videoId);
      result.failed.push({ track: t, reason: (e as Error).message });
      // Resolver desligado, ou o YouTube limitando de novo mesmo após a espera:
      // para aqui em vez de insistir (insistir é o que faz o bloqueio durar mais).
      const kind = e instanceof ResolverError ? e.kind : "temp";
      if (kind === "offline")
        stopped = "não tentada: o servidor de importação está desligado";
      if (kind === "limit" && ++limitHits >= 2)
        stopped =
          "não tentada: o YouTube está limitando os pedidos; tente de novo daqui a alguns minutos";
    }
  }

  control?.onProgress?.(tracks.length);
  onNote?.("terminando de importar...");
  await Promise.all(pending);
  // Mantém a ordem da playlist nas listas.
  const order = (a: ResolvedTrack, b: ResolvedTrack) =>
    tracks.indexOf(a) - tracks.indexOf(b);
  result.imported.sort(order);
  result.existing.sort(order);
  result.failed.sort((a, b) => order(a.track, b.track));
  result.skipped.sort(order);
  onNote?.("");
  return result;
}

/**
 * `download` com novas tentativas: falha passageira espera 3 s e depois 10 s;
 * limite do YouTube espera 45 s e tenta uma última vez. Cada tentativa pede um
 * link de áudio novo (o anterior pode ter expirado).
 */
async function downloadWithRetry(
  t: ResolvedTrack,
  i: number,
  onNote: (note: string) => void,
): Promise<File> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await download(t, i);
    } catch (e) {
      const err =
        e instanceof ResolverError
          ? e
          : new ResolverError((e as Error).message, "temp", true);
      if (!err.retryable) throw err;
      const delay =
        err.kind === "limit"
          ? attempt === 0
            ? LIMIT_BACKOFF
            : null
          : (RETRY_DELAYS[attempt] ?? null);
      if (delay === null) throw err;
      onNote(`${err.message}. Tentando de novo em ${delay / 1000} s...`);
      await wait(delay);
    }
  }
}

/** Resolve e baixa o áudio de uma faixa como `File`. */
async function download(t: ResolvedTrack, i: number): Promise<File> {
  const stream = await resolveStream(t.videoId);
  // Passa pelo resolver: o googlevideo não libera CORS para o navegador.
  let r: Response;
  try {
    r = await fetch(
      `${RESOLVER}/stream?u=${encodeURIComponent(stream.streamUrl)}`,
    );
  } catch {
    throw OFFLINE();
  }
  if (!r.ok) throw await errorFrom(r);
  const blob = await r.blob().catch(() => {
    throw new ResolverError(
      "O download foi interrompido no meio",
      "temp",
      true,
    );
  });

  // Título e artista que vão para a faixa. Do Spotify/Deezer (as que têm
  // `query`), ficam os de lá (mais limpos). Do YouTube: o metadado de música;
  // senão "Artista - Título" no nome do vídeo; senão o canal, se for oficial
  // ("- Topic", VEVO). Se nada disso der, o importador procura pelo título
  // (ou fica "Artista desconhecido").
  if (!t.query || !t.artist) {
    const videoTitle = stream.title || t.title;
    const split = stream.artist ? null : splitArtistTitle(videoTitle);
    t.artist =
      stream.artist ||
      split?.artist ||
      artistFromChannel(stream.channel ?? "") ||
      artistFromChannel(t.artist);
    t.title = split?.title || videoTitle;
  }
  const artist = t.artist;
  const title = t.title || `faixa ${i + 1}`;
  const base = artist ? `${artist} - ${title}` : title;
  // O importador reconhece pela extensão/tipo. O áudio do YouTube costuma
  // ser Opus (webm) ou AAC (m4a).
  const name = `${safeName(base)}.${guessExt(blob.type)}`;
  const file = new File([blob], name, { type: blob.type || "audio/webm" });
  if (!ACCEPTED_EXT.test(name) && !/^(audio|video)\//.test(file.type)) {
    throw new Error("formato não reconhecido");
  }
  return file;
}

/**
 * Baixa a thumbnail do vídeo para virar capa (o i.ytimg.com libera CORS, então
 * não precisa passar pelo resolver). Tenta da maior para a menor, porque nem
 * todo vídeo tem a versão HD. Sem thumbnail, a faixa fica com o vinil.
 */
async function fetchThumbnail(videoId: string): Promise<Blob | undefined> {
  for (const size of ["maxresdefault", "sddefault", "hqdefault"]) {
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${videoId}/${size}.jpg`);
      if (r.ok) return await r.blob();
    } catch {
      /* tenta a próxima */
    }
  }
  return undefined;
}

/**
 * Baixa a capa vinda do Spotify (URL do i.scdn.co). O CDN deles libera CORS,
 * então buscamos direto. Se falhar, a faixa cai na thumbnail do YouTube.
 */
async function fetchCover(url: string): Promise<Blob | undefined> {
  try {
    const r = await fetch(url);
    if (r.ok) return await r.blob();
  } catch {
    /* sem capa do Spotify: tenta a thumbnail do YouTube depois */
  }
  return undefined;
}

function guessExt(mime: string): string {
  const m = mime.split(";")[0].trim();
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("webm") || m.includes("opus") || m.includes("ogg"))
    return "opus";
  if (m.includes("mpeg")) return "mp3";
  return "opus";
}

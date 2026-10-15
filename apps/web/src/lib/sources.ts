import type { ResolvedTrack, SpotFailKind } from "@yfitops/core";
import type { Innertube } from "youtubei.js/web";
import { isNativeApp, nativeFetch } from "./native";
import { CapacitorHttp } from "@capacitor/core";

// ---------------------------------------------------------------------------
// Ler links e baixar áudio — roda no celular que ajuda (app Android), pela
// conexão dele, sem servidor no meio. É o que o antigo "resolver" (Node +
// yt-dlp) fazia:
//   - YouTube (vídeo, playlist, mix): pelo youtubei.js, a mesma API interna
//     que o app do YouTube usa;
//   - Spotify e Deezer: só a lista (nome, artista, álbum, capa). O áudio deles
//     tem DRM; cada faixa é procurada no YouTube por "artista música", como o
//     spotdl faz.
// ---------------------------------------------------------------------------

/** Falha com o tipo: "limit" = o YouTube barrou este celular; "gone" = não existe; "temp" = passageira. */
export class SourceError extends Error {
  constructor(
    message: string,
    public kind: SpotFailKind,
  ) {
    super(message);
  }
}

export interface Listing {
  provider: "youtube" | "spotify" | "deezer";
  /** Origem da playlist ("youtube-playlist:<id>"); undefined para música solta. */
  source?: string;
  name?: string;
  /** O Spotify sem login só entrega as 50 primeiras. */
  truncated: boolean;
  tracks: ResolvedTrack[];
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
/** Mixes do YouTube são quase infinitos: lemos só os primeiros. */
const MIX_LIMIT = 50;
const MAX_TRACKS = 300;

// ---------------- YouTube (youtubei.js) ----------------

/** A sessão é refeita de tempos em tempos (o YouTube troca o player). */
const SESSION_TTL = 3 * 60 * 60 * 1000;
let yt: { at: number; client: Promise<Innertube> } | null = null;

function youtube(): Promise<Innertube> {
  if (!yt || Date.now() - yt.at > SESSION_TTL) {
    const client = (async () => {
      // Só o app Android carrega o youtubei.js (~1 MB): quem só ouve não paga por isso.
      const { Innertube, Platform, Log } = await import("youtubei.js/web");
      Log.setLevel(Log.Level.NONE);
      // O player do YouTube embaralha os links do áudio; desembaralhar é rodar o código dele.
      Platform.shim.eval = async (data: { output: string }) => new Function(data.output)();
      return Innertube.create({ fetch: nativeFetch, generate_session_locally: true, retrieve_player: true });
    })();
    yt = { at: Date.now(), client };
    client.catch(() => (yt = null));
  }
  return yt.client;
}

/** ID do vídeo: watch?v=, youtu.be/<id>, /shorts/<id>, /live/<id>, /embed/<id>. */
export function videoIdOf(url: string): string | null {
  try {
    const u = new URL(url);
    const id = /(^|\.)youtu\.be$/i.test(u.hostname)
      ? u.pathname.slice(1)
      : (u.searchParams.get("v") ?? u.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1]);
    return id && /^[\w-]{6,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function listIdOf(url: string): string | null {
  try {
    const list = new URL(url).searchParams.get("list");
    return list && list.length > 1 ? list : null;
  } catch {
    return null;
  }
}

/** "3:16" → 196. */
function seconds(text: string | undefined): number {
  if (!text) return 0;
  return text.split(":").reduce((n, p) => n * 60 + (Number(p) || 0), 0);
}

/** Texto de um campo do youtubei.js (Text com .text, string, ou nada). */
const txt = (v: unknown): string => (typeof v === "string" ? v : ((v as { text?: string } | undefined)?.text ?? (v ? String(v) : "")));

/** Item de playlist em qualquer dos formatos que o YouTube devolve. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function playlistItem(v: any): ResolvedTrack | null {
  // Formato antigo (PlaylistVideo).
  if (v?.id && v?.title) {
    return { videoId: v.id, title: txt(v.title), artist: v.author?.name ?? "", duration: v.duration?.seconds ?? 0 };
  }
  // Formato novo (LockupView): id em content_id, canal na 1ª linha de metadados, duração no selo da miniatura.
  if (v?.content_id && v?.content_type === "VIDEO") {
    const rows = v.metadata?.metadata?.metadata_rows ?? [];
    const channel = txt(rows[0]?.metadata_parts?.[0]?.text);
    const badge = JSON.stringify(v.content_image ?? {}).match(/"(\d{1,2}(?::\d{2}){1,2})"/)?.[1];
    return { videoId: v.content_id, title: txt(v.metadata?.title) || "Faixa sem título", artist: channel, duration: seconds(badge) };
  }
  return null;
}

async function youtubeList(url: string): Promise<Listing> {
  const client = await youtube();
  const list = listIdOf(url);
  const vid = videoIdOf(url);
  if (!list) {
    if (!vid) throw new SourceError("Esse link não é de um vídeo nem de uma playlist", "gone");
    return { provider: "youtube", truncated: false, tracks: [await describeVideo(vid)] };
  }
  // Mix ("RD..."): não abre como playlist, só pelo vídeo que o gerou.
  if (list.startsWith("RD")) {
    const seed = vid ?? (/^RD[\w-]{11}$/.test(list) ? list.slice(2) : null);
    if (!seed) throw new SourceError("Não consegui abrir esse mix", "gone");
    const r = await client.actions.execute("/next", { videoId: seed, playlistId: list });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pl = (r.data as any)?.contents?.twoColumnWatchNextResults?.playlist?.playlist;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracks = ((pl?.contents ?? []) as any[])
      .map((c) => c.playlistPanelVideoRenderer)
      .filter((v) => v?.videoId)
      .slice(0, MIX_LIMIT)
      .map((v) => ({
        videoId: v.videoId as string,
        title: (v.title?.simpleText as string) ?? "Faixa sem título",
        artist: (v.longBylineText?.runs?.[0]?.text as string) ?? "",
        duration: seconds(v.lengthText?.simpleText),
      }));
    return { provider: "youtube", source: `youtube-playlist:${list}`, name: pl?.title, truncated: false, tracks };
  }
  let page = await client.getPlaylist(list);
  const name = txt(page.info?.title) || undefined;
  const tracks: ResolvedTrack[] = [];
  for (let guard = 0; guard < 20; guard++) {
    for (const item of page.items) {
      const t = playlistItem(item);
      if (t) tracks.push(t);
    }
    if (!page.has_continuation || tracks.length >= MAX_TRACKS) break;
    page = await page.getContinuation();
  }
  return { provider: "youtube", source: `youtube-playlist:${list}`, name, truncated: tracks.length >= MAX_TRACKS, tracks: tracks.slice(0, MAX_TRACKS) };
}

async function describeVideo(id: string): Promise<ResolvedTrack> {
  const client = await youtube();
  try {
    const info = await client.getBasicInfo(id, { client: "WEB" });
    return { videoId: id, title: info.basic_info.title ?? "Faixa sem título", artist: info.basic_info.author ?? "", duration: info.basic_info.duration ?? 0 };
  } catch {
    // Sem os dados agora: o download traz título e canal depois.
    return { videoId: id, title: "", artist: "", duration: 0 };
  }
}

/** Título comparável: sem acento, caixa, parênteses e palavras de vídeo. */
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Procura uma faixa do Spotify/Deezer no YouTube. Primeiro no YouTube Music
 * (áudio oficial, sem introdução de clipe); a duração desempata. Sem nada lá,
 * a busca comum de vídeos.
 */
export async function searchYouTube(t: ResolvedTrack): Promise<{ videoId: string; title: string; artist: string; duration: number }> {
  const client = await youtube();
  const query = t.query || [t.artist, t.title].filter(Boolean).join(" ");
  const close = (d: number) => !t.duration || !d || Math.abs(d - t.duration) <= 12;
  try {
    const r = await client.music.search(query, { type: "song" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const songs = ((r.songs?.contents ?? []) as any[]).filter((s) => s?.id);
    const pick = songs.find((s) => close(s.duration?.seconds ?? 0) && norm(s.title ?? "").includes(norm(t.title).split(" ")[0] ?? "")) ?? songs.find((s) => close(s.duration?.seconds ?? 0));
    if (pick)
      return {
        videoId: pick.id,
        title: pick.title ?? t.title,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        artist: (pick.artists ?? []).map((a: any) => a.name).join(", "),
        duration: pick.duration?.seconds ?? 0,
      };
  } catch {
    /* tenta a busca comum */
  }
  const r = await client.search(query, { type: "video" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const videos = (r.videos ?? []) as any[];
  const pick = videos.find((v) => close(v.duration?.seconds ?? 0)) ?? videos[0];
  const id = pick?.video_id ?? pick?.id;
  if (!id) throw new SourceError(`Nada encontrado no YouTube para "${query}"`, "gone");
  return { videoId: id, title: txt(pick.title), artist: pick.author?.name ?? "", duration: pick.duration?.seconds ?? 0 };
}

export interface Downloaded {
  file: File;
  title: string;
  /** Canal que publicou (nem sempre é o artista). */
  channel: string;
  duration: number;
}

/**
 * Modos do YouTube que entregam o áudio inteiro sem "prova de origem" (PO
 * token). O primeiro que funcionar ganha; os outros são reserva.
 */
const CLIENTS = ["ANDROID_VR", "TV"] as const;
/** Em pedaços: pedido único inteiro o YouTube limita à velocidade de reprodução. */
const CHUNK = 10 * 1024 * 1024;

/**
 * Só para testes no computador (o YouTube costuma barrar o computador de quem
 * testa muito): com esta chave no localStorage, o "download" é este áudio.
 */
function testAudio(): string | null {
  try {
    return localStorage.getItem("yfitops.spot-debug") === "1" ? localStorage.getItem("yfitops.spot-test-audio") : null;
  } catch {
    return null;
  }
}

/** Baixa o melhor áudio de um vídeo (pelo celular). */
export async function downloadAudio(videoId: string): Promise<Downloaded> {
  const fake = testAudio();
  if (fake) {
    const blob = await (await fetch(fake)).blob();
    // O id do vídeo no fim deixa cada arquivo diferente (senão o catálogo junta todos como o mesmo arquivo).
    return { file: new File([blob, videoId], `${videoId}.wav`, { type: "audio/wav" }), title: "", channel: "", duration: 0 };
  }
  const client = await youtube();
  let last: SourceError | null = null;
  for (const name of CLIENTS) {
    try {
      const info = await client.getBasicInfo(videoId, { client: name });
      const ps = info.playability_status;
      if (ps?.status && ps.status !== "OK") {
        const reason = ps.reason ?? ps.status;
        if (/bot/i.test(reason)) throw new SourceError("O YouTube pediu para confirmar que não é um robô", "limit");
        if (/age|idade/i.test(reason)) throw new SourceError("Vídeo com restrição de idade", "gone");
        throw new SourceError(reason, ps.status === "LOGIN_REQUIRED" ? "temp" : "gone");
      }
      const audio = (info.streaming_data?.adaptive_formats ?? []).filter((f) => f.has_audio && !f.has_video);
      const best = audio.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
      if (!best) throw new SourceError("Sem áudio disponível", "temp");
      const url = await best.decipher(client.session.player);
      const total = Number(best.content_length) || 0;
      const parts: Uint8Array[] = [];
      for (let start = 0; ; start += CHUNK) {
        const end = total ? Math.min(total, start + CHUNK) - 1 : start + CHUNK - 1;
        const r = await chunk(`${url}&range=${start}-${end}`);
        const part = new Uint8Array(await r.arrayBuffer());
        parts.push(part);
        if (total ? end >= total - 1 : part.length < CHUNK) break;
      }
      const mime = (best.mime_type ?? "audio/webm").split(";")[0];
      const ext = /mp4|m4a/.test(mime) ? "m4a" : "opus";
      const title = info.basic_info.title ?? "";
      return {
        file: new File(parts as BlobPart[], `${videoId}.${ext}`, { type: mime }),
        title,
        channel: info.basic_info.author ?? "",
        duration: info.basic_info.duration ?? 0,
      };
    } catch (e) {
      last = e instanceof SourceError ? e : classify(e);
      // Não existe: não adianta outro modo.
      if (last.kind === "gone") throw last;
    }
  }
  throw last ?? new SourceError("Não consegui baixar", "temp");
}

/** Baixa um pedaço, com duas novas tentativas se a rede falhar. */
async function chunk(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await nativeFetch(url);
      if (r.ok) return r;
      if (r.status === 429) throw new SourceError("O YouTube está limitando os downloads", "limit");
      if (r.status === 403 || attempt >= 2) throw new SourceError(`O YouTube recusou o download (${r.status})`, "temp");
    } catch (e) {
      if (e instanceof SourceError || attempt >= 2) throw e instanceof SourceError ? e : new SourceError("A conexão caiu no meio do download", "temp");
    }
    await new Promise((r) => setTimeout(r, 1000 * 3 ** attempt));
  }
}

function classify(e: unknown): SourceError {
  const msg = String((e as Error)?.message ?? e);
  if (/bot/i.test(msg)) return new SourceError("O YouTube pediu para confirmar que não é um robô", "limit");
  if (/unavailable|private|removed|not available|indispon/i.test(msg)) return new SourceError("Vídeo indisponível", "gone");
  return new SourceError(msg.slice(0, 200) || "Erro ao falar com o YouTube", "temp");
}

// ---------------- Spotify (página pública de "embed", sem login) ----------------

/** Endereço final depois dos redirecionamentos (links curtos spotify.link, deezer.page.link). */
async function finalUrl(url: string): Promise<string> {
  if (isNativeApp()) {
    const r = await CapacitorHttp.get({ url, headers: { "User-Agent": BROWSER_UA } });
    return r.url || url;
  }
  return (await fetch(url, { redirect: "follow" })).url || url;
}

async function spotifyList(url: string): Promise<Listing> {
  let u = new URL(url);
  if (/(^|\.)spotify\.link$/i.test(u.hostname)) u = new URL(await finalUrl(url));
  const m = u.pathname.match(/\/(playlist|album|track)\/(\w+)/);
  if (!m) throw new SourceError("Esse link do Spotify não é de uma playlist, álbum ou música", "gone");
  const [, type, id] = m;
  const r = await nativeFetch(`https://open.spotify.com/embed/${type}/${id}`, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" },
  });
  if (!r.ok) throw new SourceError(`O Spotify respondeu ${r.status}`, r.status === 404 ? "gone" : "temp");
  const html = await r.text();
  const json = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  if (!json) throw new SourceError("A página do Spotify mudou e não deu para ler a lista", "temp");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entity = (JSON.parse(json) as any)?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new SourceError("O Spotify não mostrou essa lista (é privada?)", "gone");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toTrack = (it: any, cover: string): ResolvedTrack => {
    const artist = it.subtitle || (it.artists ?? []).map((a: { name: string }) => a.name).join(", ") || "";
    const title = it.title ?? it.name ?? "Faixa sem título";
    return {
      videoId: "",
      spotifyId: String(it.uri ?? "").split(":").pop() || undefined,
      title,
      artist,
      duration: Math.round((it.duration ?? 0) / 1000),
      cover: it.coverArt?.sources?.[0]?.url || cover || undefined,
      query: [artist, title].filter(Boolean).join(" "),
    };
  };
  if (type === "track") return { provider: "spotify", truncated: false, tracks: [toTrack(entity, "")] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = ((entity.trackList ?? []) as any[]).filter((it) => it && (it.title || it.name));
  const cover = entity.coverArt?.sources?.[0]?.url ?? "";
  return {
    provider: "spotify",
    source: `spotify-playlist:${id}`,
    name: entity.title || entity.name || undefined,
    truncated: items.length >= 50,
    tracks: items.map((it) => toTrack(it, cover)),
  };
}

// ---------------- Deezer (API pública, sem conta) ----------------

async function deezerGet<T>(path: string): Promise<T> {
  const r = await nativeFetch(path.startsWith("http") ? path : `https://api.deezer.com${path}`);
  if (!r.ok) throw new SourceError(`O Deezer respondeu ${r.status}`, "temp");
  const body = await r.json();
  if (body?.error) {
    const code = body.error.code;
    throw new SourceError(
      code === 800 ? "Não achei essa lista no Deezer (é privada?)" : `O Deezer recusou: ${body.error.message ?? code}`,
      code === 800 ? "gone" : "temp",
    );
  }
  return body as T;
}

interface DeezerTrack {
  id: number;
  title?: string;
  title_short?: string;
  duration?: number;
  artist?: { name?: string };
  album?: { title?: string; cover_xl?: string; cover_big?: string };
}

function fromDeezer(t: DeezerTrack, album?: DeezerTrack["album"]): ResolvedTrack {
  const artist = t.artist?.name ?? "";
  const title = t.title_short || t.title || "Faixa sem título";
  const a = t.album ?? album ?? {};
  return {
    videoId: "",
    deezerId: String(t.id),
    title,
    artist,
    album: a.title || undefined,
    duration: t.duration ?? 0,
    cover: a.cover_xl || a.cover_big || undefined,
    query: [artist, title].filter(Boolean).join(" "),
  };
}

async function deezerList(url: string): Promise<Listing> {
  let u = new URL(url);
  if (!/(^|\.)deezer\.com$/i.test(u.hostname) || u.hostname.startsWith("link.")) u = new URL(await finalUrl(url));
  const m = u.pathname.match(/\/(playlist|album|track)\/(\d+)/);
  if (!m) throw new SourceError("Esse link do Deezer não é de uma playlist, álbum ou música", "gone");
  const [, type, id] = m;
  if (type === "track") return { provider: "deezer", truncated: false, tracks: [fromDeezer(await deezerGet<DeezerTrack>(`/track/${id}`))] };
  const info = await deezerGet<{ title?: string } & DeezerTrack["album"]>(`/${type}/${id}`);
  const album = type === "album" ? info : undefined;
  const tracks: ResolvedTrack[] = [];
  let next: string | null = `/${type}/${id}/tracks?limit=100`;
  for (let guard = 0; next && guard < 10 && tracks.length < MAX_TRACKS; guard++) {
    const page: { data?: DeezerTrack[]; next?: string } = await deezerGet(next);
    for (const t of page.data ?? []) if (t?.id) tracks.push(fromDeezer(t, album));
    next = page.next ?? null;
  }
  return { provider: "deezer", source: `deezer-playlist:${type}-${id}`, name: info.title || undefined, truncated: false, tracks: tracks.slice(0, MAX_TRACKS) };
}

// ---------------- Entrada ----------------

/** Lê um link (YouTube, Spotify ou Deezer) e devolve as músicas, sem baixar nada ainda. */
export async function readLink(url: string): Promise<Listing> {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    throw new SourceError("Link inválido", "gone");
  }
  try {
    if (/(^|\.)(spotify\.com|spotify\.link)$/i.test(host)) return await spotifyList(url);
    if (/(^|\.)(deezer\.com|deezer\.page\.link|dzr\.page\.link)$/i.test(host)) return await deezerList(url);
    return await youtubeList(url);
  } catch (e) {
    throw e instanceof SourceError ? e : classify(e);
  }
}

/**
 * Baixa a capa (thumbnail do vídeo ou a do Spotify/Deezer). Tenta da maior para a
 * menor, porque nem todo vídeo tem a HD. Sem capa, a música fica com o vinil.
 */
export async function fetchCover(t: ResolvedTrack, videoId: string): Promise<Blob | undefined> {
  const urls = [
    ...(t.cover && /^https:\/\/([\w-]+\.)*(scdn\.co|spotifycdn\.com|dzcdn\.net|deezer\.com)\//.test(t.cover) ? [t.cover] : []),
    ...["maxresdefault", "sddefault", "hqdefault"].map((s) => `https://i.ytimg.com/vi/${videoId}/${s}.jpg`),
  ];
  for (const url of urls) {
    try {
      const r = await nativeFetch(url);
      if (r.ok) return await r.blob();
    } catch {
      /* tenta a próxima */
    }
  }
  return undefined;
}

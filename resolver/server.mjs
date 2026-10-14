import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Servidor "ajudante" do yfitops.
//
// Ele NÃO guarda música nenhuma. Ele só faz uma coisa: recebe um link de
// playlist (do YouTube ou do Spotify) e devolve a lista de faixas com a URL
// do áudio de cada uma. Quem baixa, converte, criptografa e sobe é o app
// (pipeline que já existe).
//
// Sobre o Spotify: a API oficial só entrega os METADADOS (nome, artista,
// álbum, capa). O áudio do Spotify é protegido por DRM e não é acessível.
// Então, para uma playlist do Spotify, a gente lê a lista pela API e depois
// procura cada faixa no YouTube (por "artista - música") para baixar o áudio.
// É o mesmo que ferramentas como o spotdl fazem.
//
// Rode com:  npm start        (abre em http://127.0.0.1:8788)
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8788;
const BIN = process.env.YTDLP_PATH || "yt-dlp"; // caminho do yt-dlp, se não estiver no PATH

// Credenciais do Spotify (opcionais, só necessárias para playlists do Spotify).
// Crie um app em https://developer.spotify.com/dashboard e copie o Client ID e
// o Client Secret. Usa-se só "Client Credentials": não precisa de login de
// usuário nem de redirect URI.
//   SPOTIFY_CLIENT_ID=xxxxxxxx
//   SPOTIFY_CLIENT_SECRET=yyyyyyyy
const SPOTIFY_ID = process.env.SPOTIFY_CLIENT_ID || "";
const SPOTIFY_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";

// Cookies de uma conta logada (opcional). Ajudam quando o YouTube pede a
// verificação anti-robô. Use UMA das duas:
//   YTDLP_COOKIES_FROM_BROWSER=firefox   (lê do navegador; no Windows, o Firefox funciona melhor)
//   YTDLP_COOKIES=C:\caminho\cookies.txt (arquivo exportado no formato Netscape)
const COOKIES = process.env.YTDLP_COOKIES_FROM_BROWSER
  ? ["--cookies-from-browser", process.env.YTDLP_COOKIES_FROM_BROWSER]
  : process.env.YTDLP_COOKIES
    ? ["--cookies", process.env.YTDLP_COOKIES]
    : [];

/** Roda o yt-dlp com os argumentos dados e devolve o que ele imprimiu. */
function ytDlp(args) {
  return new Promise((resolve, reject) => {
    execFile(
      BIN,
      [...args, ...COOKIES, "--extractor-retries", "3"],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          err.message += stderr ? `\n${stderr.trim()}` : "";
          return reject(err);
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Traduz a falha do yt-dlp/YouTube num motivo legível e diz se vale tentar de
 * novo. `kind` = "limit" quando o YouTube está segurando os pedidos: aí o app
 * desacelera em vez de insistir.
 */
function explain(err) {
  // Erros que já vêm com kind/retryable definidos (Spotify, config) passam
  // direto: sabemos exatamente o que houve.
  if (err && err.kind)
    return {
      kind: err.kind,
      retryable: err.retryable ?? true,
      error: err.message || "Falha ao resolver a playlist",
    };
  const m = String(err?.message ?? err);
  if (
    /not a bot|confirm you.re not|HTTP Error 429|Too Many Requests|rate.?limit/i.test(
      m,
    )
  )
    return {
      kind: "limit",
      retryable: true,
      error:
        "O YouTube está limitando os pedidos (verificação anti-robô). Espere alguns minutos e tente de novo.",
    };
  if (/confirm your age|age.restricted|inappropriate for some users/i.test(m))
    return {
      kind: "age",
      retryable: false,
      error:
        "Vídeo com restrição de idade (precisa de cookies de uma conta logada)",
    };
  if (/Private video|private/i.test(m))
    return { kind: "gone", retryable: false, error: "Vídeo privado" };
  if (/unavailable|removed|terminated|does not exist/i.test(m))
    return {
      kind: "gone",
      retryable: false,
      error: "Vídeo indisponível ou removido",
    };
  if (/not available in your country|geo.?restrict/i.test(m))
    return {
      kind: "gone",
      retryable: false,
      error: "Vídeo bloqueado na sua região",
    };
  if (/members.only|join this channel/i.test(m))
    return {
      kind: "gone",
      retryable: false,
      error: "Vídeo exclusivo para membros do canal",
    };
  if (/HTTP Error 403|Forbidden/i.test(m))
    return {
      kind: "temp",
      retryable: true,
      error: "O YouTube recusou o pedido (403)",
    };
  return {
    kind: "temp",
    retryable: true,
    error: "Falha temporária ao falar com o YouTube",
  };
}

// Só aceitamos links do YouTube. Nada de o servidor virar proxy aberto para
// qualquer site (isso evita abuso de banda e é mais seguro).
const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com)$/i;

function isYouTube(url) {
  try {
    return YOUTUBE_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Spotify
// ---------------------------------------------------------------------------

const SPOTIFY_HOSTS = /(^|\.)(spotify\.com|spotify\.link)$/i;

function isSpotify(url) {
  try {
    return SPOTIFY_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Lê o ID e o tipo (playlist/album/track) de um link do Spotify.
 * Aceita open.spotify.com/playlist/<id>, /album/<id>, /track/<id> e links
 * curtos spotify.link/<id> (que redirecionam).
 */
async function spotifyTarget(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // Link curto precisa de um HEAD para seguir o redirect.
  if (/(^|\.)spotify\.link$/i.test(u.hostname)) {
    try {
      const r = await fetch(url, { method: "HEAD", redirect: "follow" });
      u = new URL(r.url);
    } catch {
      return null;
    }
  }
  const m = u.pathname.match(/\/(playlist|album|track)\/([\w]+)/);
  return m ? { type: m[1], id: m[2] } : null;
}

let spotifyToken = { value: "", expires: 0 };

/** Pega (e renova) um token de aplicação do Spotify via Client Credentials. */
async function spotifyAuth() {
  if (!SPOTIFY_ID || !SPOTIFY_SECRET)
    throw Object.assign(
      new Error(
        "Playlists do Spotify precisam de SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET no servidor.",
      ),
      { kind: "config", retryable: false },
    );
  if (spotifyToken.value && Date.now() < spotifyToken.expires)
    return spotifyToken.value;
  const basic = Buffer.from(`${SPOTIFY_ID}:${SPOTIFY_SECRET}`).toString(
    "base64",
  );
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw Object.assign(
      new Error(
        `O Spotify recusou as credenciais (HTTP ${r.status}) ${detail}`.trim(),
      ),
      {
        kind: r.status === 401 ? "config" : "temp",
        retryable: r.status !== 401,
      },
    );
  }
  const { access_token, expires_in } = await r.json();
  spotifyToken = {
    value: access_token,
    expires: Date.now() + (expires_in - 60) * 1000,
  };
  return access_token;
}

/** GET autenticado na API do Spotify. */
async function spotifyGet(path) {
  const token = await spotifyAuth();
  const r = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    const kind =
      r.status === 401
        ? "config"
        : r.status === 404
          ? "gone"
          : r.status === 429
            ? "limit"
            : "temp";
    throw Object.assign(new Error(`O Spotify respondeu HTTP ${r.status}`), {
      kind,
      retryable: kind === "temp" || kind === "limit",
      retryAfter: Number(r.headers.get("retry-after")) || 0,
    });
  }
  return r.json();
}

const spotifyArtists = (item) =>
  (item?.artists ?? item?.album?.artists ?? [])
    .map((a) => a.name)
    .filter(Boolean)
    .join(", ");

/** Nome da playlist ou do álbum no Spotify (vira o nome da playlist no app). */
async function spotifyName(target) {
  try {
    const info = await spotifyGet(
      target.type === "playlist"
        ? `/playlists/${target.id}?fields=name`
        : `/albums/${target.id}`,
    );
    return info?.name || null;
  } catch {
    return null; // sem nome: o app usa um padrão
  }
}

/**
 * Lista as faixas de uma playlist/álbum do Spotify, ou uma faixa solta.
 * Devolve o mesmo formato das faixas do YouTube, mais um campo `query` com o
 * texto que será buscado no YouTube ("artista - música álbum").
 */
async function spotifyList(target) {
  const raw = [];
  if (target.type === "track") {
    raw.push(await spotifyGet(`/tracks/${target.id}`));
  } else {
    // Playlist ou álbum: a estrutura é a mesma em /tracks (o álbum tem `items`).
    const path = `/${target.type}s/${target.id}/tracks`;
    let next = `${path}?limit=50`;
    let guard = 0;
    while (next && guard++ < 40) {
      const page = await spotifyGet(next);
      for (const it of page.items ?? []) {
        const t = it.track ?? it; // playlists vêm embrulhadas em { track }
        if (t && t.id) raw.push(t);
      }
      // A API devolve a URL completa da próxima página; extrai o caminho.
      next = page.next
        ? new URL(page.next).pathname + new URL(page.next).search
        : null;
    }
  }
  return raw.map((t) => {
    const artist = spotifyArtists(t);
    const album = t.album?.name || "";
    const cover = t.album?.images?.[0]?.url || "";
    // A busca no YouTube fica melhor com "artista - título" e, quando houver,
    // o álbum ajuda a desambiguar (ex.: versões de estúdio vs. ao vivo).
    const query = [artist, t.name, album].filter(Boolean).join(" ");
    return {
      videoId: "", // preenchido ao resolver no YouTube
      spotifyId: t.id,
      title: t.name || "Faixa sem título",
      artist,
      album,
      duration: Math.round((t.duration_ms ?? 0) / 1000),
      cover,
      query,
    };
  });
}

// ---------------------------------------------------------------------------
// Scraping do embed público do Spotify (sem API e sem login).
//
// Quando não há credenciais (SPOTIFY_CLIENT_ID/SECRET), lemos a página de
// embed — https://open.spotify.com/embed/<tipo>/<id> — que traz um JSON
// embutido (`__NEXT_DATA__`) com o nome da playlist, a capa e as faixas.
// Não precisa de login nem de Premium. Limitação: o embed lista só as
// primeiras 50 faixas.
// ---------------------------------------------------------------------------

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** Extrai o JSON de `__NEXT_DATA__` de uma página HTML. */
function nextData(html) {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!m) throw new Error("Não achei os dados embutidos na página do Spotify");
  return JSON.parse(m[1]);
}

/** Baixa a página de embed e devolve o `entity` (a playlist/álbum/faixa). */
async function spotifyEmbedEntity(target) {
  const r = await fetch(
    `https://open.spotify.com/embed/${target.type}/${target.id}`,
    {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
    },
  );
  if (!r.ok)
    throw Object.assign(new Error(`O Spotify respondeu HTTP ${r.status}`), {
      kind: r.status === 404 ? "gone" : "temp",
      retryable: r.status !== 404,
    });
  const data = nextData(await r.text());
  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error("A página do Spotify veio sem dados");
  return entity;
}

/**
 * Lista as faixas de uma playlist/álbum do Spotify via embed público.
 * Devolve no mesmo formato do `spotifyList` (com `query` para o YouTube).
 */
async function spotifyListEmbed(target) {
  const entity = await spotifyEmbedEntity(target);

  // Faixa solta: o embed traz a própria faixa em `entity` (com `title`).
  if (target.type === "track") {
    return [
      toTrack({
        uri: entity.uri,
        title: entity.title ?? entity.name,
        subtitle: artistsOf(entity),
        duration: entity.duration,
        cover: entity.coverArt?.sources?.[0]?.url,
      }),
    ];
  }

  const items = Array.isArray(entity.trackList) ? entity.trackList : [];
  const cover = entity.coverArt?.sources?.[0]?.url || "";
  const tracks = items
    .filter((it) => it && (it.title || it.name))
    .map((it) =>
      toTrack({
        uri: it.uri,
        title: it.title ?? it.name,
        subtitle:
          it.subtitle || (it.artists ?? []).map((a) => a.name).join(", "),
        duration: it.duration,
        cover: it.coverArt?.sources?.[0]?.url || cover,
      }),
    );
  // `title` é o nome da playlist/álbum; `subtitle`, quem a fez.
  return {
    tracks,
    truncated: items.length >= 50,
    name: entity.title || entity.name || null,
  };
}

/** Vira um `ResolvedTrack` "de YouTube ainda vazio" (com o `query` da busca). */
function toTrack({ uri, title, subtitle, duration, cover }) {
  const artist = subtitle || "";
  const name = title || "Faixa sem título";
  return {
    videoId: "", // preenchido ao resolver no YouTube
    spotifyId: (uri || "").split(":").pop() || "",
    title: name,
    artist,
    album: "",
    duration: Math.round((duration ?? 0) / 1000),
    cover: cover || "",
    query: [artist, name].filter(Boolean).join(" "),
  };
}

/** Nomes dos artistas de um `entity` do embed (playlist/faixa). */
function artistsOf(entity) {
  const a = entity?.artists ?? entity?.authors ?? [];
  return (Array.isArray(a) ? a : [a])
    .map((x) => x?.name)
    .filter(Boolean)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Deezer
//
// Igual ao Spotify: o áudio do Deezer é protegido (DRM) e não é baixado de lá.
// A API pública (sem conta e sem chave) entrega a lista completa, com nome,
// artista, álbum e capa; cada faixa é procurada e baixada no YouTube depois.
// ---------------------------------------------------------------------------

const DEEZER_HOSTS =
  /(^|\.)(deezer\.com|deezer\.page\.link|dzr\.page\.link|link\.deezer\.com)$/i;

function isDeezer(url) {
  try {
    return DEEZER_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Lê o tipo e o ID de um link do Deezer: deezer.com/<idioma>/playlist/<id>,
 * /album/<id>, /track/<id>, e os links curtos (que redirecionam).
 */
async function deezerTarget(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)deezer\.com$/i.test(u.hostname) || u.hostname.startsWith("link.")) {
    try {
      const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000) });
      u = new URL(r.url);
    } catch {
      return null;
    }
  }
  const m = u.pathname.match(/\/(playlist|album|track)\/(\d+)/);
  return m ? { type: m[1], id: m[2] } : null;
}

/** GET na API do Deezer. Ela responde 200 até com erro, no campo `error`. */
async function deezerGet(path) {
  const r = await fetch(
    path.startsWith("http") ? path : `https://api.deezer.com${path}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!r.ok)
    throw Object.assign(new Error(`O Deezer respondeu HTTP ${r.status}`), {
      kind: "temp",
      retryable: true,
    });
  const body = await r.json();
  if (body?.error) {
    // 4 = limite de pedidos; 800 = não existe ou é privada.
    const code = body.error.code;
    throw Object.assign(
      new Error(
        code === 800
          ? "Não achei essa playlist no Deezer (ela é privada?)"
          : `O Deezer recusou o pedido: ${body.error.message ?? code}`,
      ),
      {
        kind: code === 4 ? "limit" : code === 800 ? "gone" : "temp",
        retryable: code !== 800,
      },
    );
  }
  return body;
}

/** Faixa do Deezer → `ResolvedTrack` sem videoId (com `query` para o YouTube). */
function fromDeezer(t, album) {
  const artist = t.artist?.name ?? "";
  const title = t.title_short || t.title || "Faixa sem título";
  const albumInfo = t.album ?? album ?? {};
  return {
    videoId: "", // preenchido ao resolver no YouTube
    deezerId: String(t.id),
    title,
    artist,
    album: albumInfo.title ?? "",
    duration: t.duration ?? 0,
    cover: albumInfo.cover_xl || albumInfo.cover_big || "",
    query: [artist, title].filter(Boolean).join(" "),
  };
}

/** Lista as faixas de uma playlist/álbum do Deezer, ou uma faixa solta. */
async function deezerList(target) {
  if (target.type === "track") {
    return { name: null, tracks: [fromDeezer(await deezerGet(`/track/${target.id}`))] };
  }
  const info = await deezerGet(`/${target.type}/${target.id}`);
  // Nos álbuns, as faixas não trazem o álbum: usa o do próprio pedido.
  const album = target.type === "album" ? info : undefined;
  const tracks = [];
  let next = `/${target.type}/${target.id}/tracks?limit=100`;
  let guard = 0;
  while (next && guard++ < 50) {
    const page = await deezerGet(next);
    // Inclui as "indisponíveis no Deezer" (readable: false): o áudio vem do YouTube.
    for (const t of page.data ?? []) if (t?.id) tracks.push(fromDeezer(t, album));
    next = page.next ?? null;
  }
  return { name: info.title || null, tracks };
}

// ---------------------------------------------------------------------------
// Resolver uma faixa por BUSCA de texto no YouTube (usado pelo Spotify e Deezer).
// É o mesmo que o spotdl faz: procura "artista - música" e pega o melhor
// resultado. Pede só os metadados (rápido); o áudio vem depois pelo /stream.
// ---------------------------------------------------------------------------

/**
 * Procura no YouTube a melhor correspondência para um texto e devolve o
 * primeiro resultado. `--flat-playlist` evita baixar info de cada vídeo.
 */
async function searchYouTube(query) {
  const out = await ytDlp([
    `ytsearch1:${query}`,
    "--dump-single-json",
    "--flat-playlist",
    "--no-warnings",
  ]);
  const info = JSON.parse(out);
  const first = info?.entries?.[0];
  if (!first?.id) throw new Error(`Nada encontrado no YouTube para "${query}"`);
  return {
    videoId: first.id,
    title: first.title ?? "",
    artist: first.uploader ?? first.channel ?? "",
    duration: first.duration ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Descobrir o artista de uma música só pelo título (para quando o arquivo não
// traz e o nome não diz). Só aceita um resultado cujo título bata com o da
// música: um artista errado é pior que "Artista desconhecido".
// ---------------------------------------------------------------------------

/** Título comparável: sem acento, sem "(Official Video)", "[Lyrics]", "feat." etc. */
function normTitle(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, " ")
    .replace(/\b(official|video|audio|lyrics?|letra|clipe|hd|4k|remaster(ed)?|feat\.?|ft\.?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const sameTitle = (a, b) => {
  const x = normTitle(a);
  const y = normTitle(b);
  return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
};

/** Procura no Spotify (só com credenciais) uma faixa com esse título. */
async function artistOnSpotify(title) {
  if (!SPOTIFY_ID || !SPOTIFY_SECRET) return "";
  const r = await spotifyGet(
    `/search?type=track&limit=5&q=${encodeURIComponent(title)}`,
  );
  const hit = (r?.tracks?.items ?? []).find((t) => sameTitle(t.name, title));
  return hit ? spotifyArtists(hit) : "";
}

// O YouTube fica de fora daqui de propósito: cada pedido a mais lá aumenta a
// chance de bloqueio, e ele já é necessário para baixar o áudio. Deezer e
// iTunes têm APIs públicas de catálogo, sem conta e sem chave.

/** GET de JSON numa API pública de catálogo (falha = "não achei", nunca erro). */
async function catalogGet(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${new URL(url).hostname}`);
  return r.json();
}

/** Deezer: catálogo grande (bom em música brasileira), ~50 pedidos a cada 5 s. */
async function artistOnDeezer(title) {
  const r = await catalogGet(
    `https://api.deezer.com/search?limit=10&q=${encodeURIComponent(title)}`,
  );
  const hit = (r?.data ?? []).find(
    (t) => sameTitle(t.title_short ?? t.title, title) && t.artist?.name,
  );
  return hit ? hit.artist.name : "";
}

/** iTunes Search: reserva, porque o limite é menor (~20 pedidos por minuto). */
async function artistOnITunes(title) {
  const r = await catalogGet(
    `https://itunes.apple.com/search?media=music&entity=song&limit=10&term=${encodeURIComponent(title)}`,
  );
  const hit = (r?.results ?? []).find(
    (t) => sameTitle(t.trackName, title) && t.artistName,
  );
  return hit ? hit.artistName : "";
}

/** Títulos já procurados (inclusive os sem resposta), para não perguntar de novo. */
const artistCache = new Map();

async function findArtist(title) {
  const key = normTitle(title);
  if (artistCache.has(key)) return artistCache.get(key);
  let found = "";
  for (const [name, source] of [
    ["Spotify", artistOnSpotify],
    ["Deezer", artistOnDeezer],
    ["iTunes", artistOnITunes],
  ]) {
    try {
      found = await source(title);
    } catch (e) {
      console.warn(`Busca de artista no ${name} falhou: ${title}`, e.message);
    }
    if (found) break;
  }
  artistCache.set(key, found);
  return found;
}

/** Lê o ID da playlist de um link (o parâmetro `list=...`), incluindo rádios/mixes ("RD..."). */
function playlistId(url) {
  try {
    const list = new URL(url).searchParams.get("list");
    return list && list.length > 1 ? list : null;
  } catch {
    return null;
  }
}

/**
 * Rádios/mixes do YouTube ("RD..."): listas geradas a partir de um vídeo, quase
 * infinitas (um mix chega a ter 500+ vídeos). Lemos só os primeiros.
 */
const MIX_LIMIT = Number(process.env.YT_MIX_LIMIT) || 50;
const isMix = (list) => list.startsWith("RD");

/** Lê o ID do vídeo: watch?v=, youtu.be/<id>, /shorts/<id>, /live/<id>, /embed/<id>. */
function videoId(url) {
  try {
    const u = new URL(url);
    const id = /(^|\.)youtu\.be$/i.test(u.hostname)
      ? u.pathname.slice(1)
      : (u.searchParams.get("v") ??
        u.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1]);
    return id && /^[\w-]{6,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Dados de um vídeo solto, no mesmo formato de um item da playlist. */
async function describeVideo(id) {
  const info = JSON.parse(
    await ytDlp([
      `https://www.youtube.com/watch?v=${id}`,
      "--dump-single-json",
      "--skip-download",
      "--no-playlist",
      "--no-warnings",
    ]),
  );
  return {
    videoId: id,
    title: info?.title ?? "Faixa sem título",
    artist: info?.artist ?? info?.uploader ?? info?.channel ?? "",
    duration: info?.duration ?? 0,
  };
}

/**
 * Pede ao yt-dlp a lista "achatada" da playlist: título, artista e duração de
 * cada vídeo, sem baixar nada ainda. É rápido e barato.
 */
async function listPlaylist(id, seedVideo) {
  // Mix não abre pelo endereço de playlist ("This playlist type is unviewable"):
  // só pelo do vídeo que gerou o mix. Sem o vídeo no link, o ID do mix
  // costuma ser "RD" + o ID do vídeo.
  const mix = isMix(id);
  const seed = seedVideo ?? (/^RD[\w-]{11}$/.test(id) ? id.slice(2) : null);
  const url =
    mix && seed
      ? `https://www.youtube.com/watch?v=${seed}&list=${id}`
      : `https://www.youtube.com/playlist?list=${id}`;
  const info = JSON.parse(
    await ytDlp([
      url,
      "--dump-single-json",
      "--flat-playlist",
      ...(mix ? ["--playlist-end", String(MIX_LIMIT)] : []),
      "--ignore-errors",
      "--no-warnings",
    ]),
  );
  const entries = info?.entries ?? [];
  const tracks = entries
    .filter((e) => e && e.id)
    .map((e) => ({
      videoId: e.id,
      title: e.title ?? "Faixa sem título",
      // Em playlists de música o yt-dlp às vezes traz uploader/artista separado.
      artist: e.uploader ?? e.channel ?? e.artist ?? "",
      duration: e.duration ?? 0,
    }));
  return { name: info?.title || null, tracks };
}

/**
 * Para um vídeo, devolve a URL direta do melhor áudio e também as tags, numa
 * chamada só ao yt-dlp (menos pedidos ao YouTube = menos chance de bloqueio).
 * `-f bestaudio` = só a faixa de áudio, no melhor formato disponível.
 */
async function resolveTrack(videoId) {
  const info = JSON.parse(
    await ytDlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      "-f",
      "bestaudio",
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
    ]),
  );
  const streamUrl = info?.url ?? info?.requested_formats?.[0]?.url;
  if (!streamUrl) throw new Error(`Sem áudio para ${videoId}`);
  return {
    streamUrl,
    title: info?.track || info?.title || "",
    // `artist` só quando o YouTube tem o metadado de música de verdade; o canal
    // vem à parte, porque nem sempre é o artista (canais de letra, reuploads...).
    artist: info?.artist || "",
    channel: info?.uploader || info?.channel || "",
  };
}

/**
 * Baixa um pedaço do áudio, tentando de novo (com espera crescente) se a rede
 * ou o YouTube falharem de forma passageira. 403 e 429 não adianta insistir na hora.
 */
async function fetchChunk(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (
        r.ok ||
        attempt >= 2 ||
        r.status === 403 ||
        r.status === 429 ||
        r.status < 500
      )
        return r;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000 * 3 ** attempt)); // 1 s, 3 s
  }
}

// --------------- HTTP ---------------

/** Responde com o motivo real da falha (ver `explain`). */
function fail(res, err) {
  const info = explain(err);
  return json(
    res,
    info.kind === "limit" ? 429 : info.kind === "temp" ? 502 : 422,
    info,
  );
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error("Corpo grande demais"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") return json(res, 204, {});

  // Checagem simples de saúde.
  if (req.method === "GET" && pathname === "/health") {
    return json(res, 200, { ok: true });
  }

  // POST /resolve { url }  =>  { provider, playlist, name, tracks: [{ videoId, title, artist, duration }] }
  // Aceita link de playlist ou de um vídeo solto (aí a lista tem uma faixa só).
  if (req.method === "POST" && pathname === "/resolve") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const { url } = body;
    if (typeof url !== "string" || !url)
      return json(res, 400, { error: "Informe uma URL" });

    // ---- Spotify: as faixas vêm sem videoId; o app resolve cada uma no
    // YouTube depois, via /resolve/search. Usa a API oficial se houver
    // credenciais; senão, faz scraping do embed público (sem login). ----
    if (isSpotify(url)) {
      const target = await spotifyTarget(url);
      if (!target)
        return json(res, 400, {
          error: "Esse link do Spotify não é de uma playlist, álbum ou faixa",
        });
      try {
        const viaApi = Boolean(SPOTIFY_ID && SPOTIFY_SECRET);
        let tracks = [];
        let truncated = false;
        let name = null;
        if (viaApi) {
          tracks = await spotifyList(target);
          if (target.type !== "track") name = await spotifyName(target);
        } else {
          const res = await spotifyListEmbed(target);
          if (Array.isArray(res)) tracks = res;
          else {
            tracks = res.tracks;
            truncated = res.truncated;
            name = res.name;
          }
        }
        if (!tracks.length)
          return json(res, 404, { error: "Essa playlist está vazia" });
        return json(res, 200, {
          provider: "spotify",
          // Faixa solta não vira playlist no app; playlist e álbum viram.
          playlist: target.type === "track" ? null : target.id,
          name: target.type === "track" ? null : name,
          truncated,
          tracks,
        });
      } catch (e) {
        console.error("Falha ao ler a playlist do Spotify", e);
        return fail(res, e);
      }
    }

    // ---- Deezer: como o Spotify, só a lista; o áudio vem do YouTube. ----
    if (isDeezer(url)) {
      const target = await deezerTarget(url);
      if (!target)
        return json(res, 400, {
          error: "Esse link do Deezer não é de uma playlist, álbum ou faixa",
        });
      try {
        const { name, tracks } = await deezerList(target);
        if (!tracks.length)
          return json(res, 404, { error: "Essa playlist está vazia" });
        return json(res, 200, {
          provider: "deezer",
          playlist: target.type === "track" ? null : `${target.type}-${target.id}`,
          name,
          truncated: false,
          tracks,
        });
      } catch (e) {
        console.error("Falha ao ler a playlist do Deezer", e);
        return fail(res, e);
      }
    }

    if (!isYouTube(url))
      return json(res, 400, {
        error: "Só aceitamos links do YouTube, do Spotify ou do Deezer",
      });

    const list = playlistId(url);
    if (!list) {
      const id = videoId(url);
      if (!id)
        return json(res, 400, {
          error: "Esse link não é de um vídeo nem de uma playlist",
        });
      try {
        return json(res, 200, {
          playlist: null,
          tracks: [await describeVideo(id)],
        });
      } catch (e) {
        console.error(`Falha ao ler o vídeo ${id}`, e);
        return fail(res, e);
      }
    }

    try {
      const { name, tracks } = await listPlaylist(list, videoId(url));
      if (!tracks.length)
        return json(res, 404, { error: "A playlist está vazia ou é privada" });
      // Só a listagem: rápida e barata. O áudio de cada faixa vem pelo
      // /resolve/track, uma por vez, para o app mostrar progresso.
      return json(res, 200, {
        provider: "youtube",
        playlist: list,
        name,
        tracks,
      });
    } catch (e) {
      console.error("Falha ao ler a playlist", e);
      return fail(res, e);
    }
  }

  // POST /resolve/track { videoId } => { videoId, title, artist, streamUrl }
  // O app chama isto uma vez por música, baixa o áudio e joga no importador.
  if (req.method === "POST" && pathname === "/resolve/track") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const { videoId } = body;
    if (typeof videoId !== "string" || !/^[\w-]{6,20}$/.test(videoId)) {
      return json(res, 400, { error: "videoId inválido" });
    }
    try {
      const t = await resolveTrack(videoId);
      return json(res, 200, { videoId, ...t });
    } catch (e) {
      console.error(`Falha ao resolver ${videoId}`, e);
      return fail(res, e);
    }
  }

  // POST /resolve/search { query } => { videoId, title, artist, duration }
  // Procura uma faixa no YouTube por texto ("artista - música"). Usado pelo
  // app para as músicas do Spotify, que não têm videoId até serem buscadas.
  if (req.method === "POST" && pathname === "/resolve/search") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const { query } = body;
    if (typeof query !== "string" || !query.trim())
      return json(res, 400, { error: "Informe o que procurar" });
    try {
      const t = await searchYouTube(query.trim());
      return json(res, 200, t);
    } catch (e) {
      console.error(`Falha ao buscar no YouTube: ${query}`, e);
      return fail(res, e);
    }
  }

  // POST /resolve/artist { title } => { artist } ("" quando não achou com segurança)
  if (req.method === "POST" && pathname === "/resolve/artist") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const { title } = body;
    if (typeof title !== "string" || !title.trim())
      return json(res, 400, { error: "Informe o título da música" });
    try {
      return json(res, 200, { artist: await findArtist(title.trim()) });
    } catch (e) {
      console.error(`Falha ao procurar o artista: ${title}`, e);
      return fail(res, e);
    }
  }

  // GET /stream?u=<streamUrl> => o áudio em si, com CORS liberado.
  // O navegador não pode baixar direto do googlevideo (ele não manda
  // Access-Control-Allow-Origin), então este servidor repassa os bytes.
  // Só aceita URLs do googlevideo, para não virar proxy aberto.
  if (req.method === "GET" && pathname === "/stream") {
    const target = new URL(req.url, "http://x").searchParams.get("u") ?? "";
    let host = "";
    try {
      host = new URL(target).hostname;
    } catch {
      /* URL inválida */
    }
    if (!/(^|\.)googlevideo\.com$/i.test(host))
      return json(res, 400, { error: "URL de áudio inválida" });
    // Baixa em pedaços (&range=): pedido único inteiro o YouTube limita à
    // velocidade de reprodução (minutos por música); em pedaços leva segundos.
    const CHUNK = 10 * 1024 * 1024;
    try {
      for (let start = 0; ; start += CHUNK) {
        const upstream = await fetchChunk(
          `${target}&range=${start}-${start + CHUNK - 1}`,
        );
        if (!upstream.ok || !upstream.body) {
          if (!res.headersSent)
            return json(res, upstream.status === 429 ? 429 : 502, {
              error:
                upstream.status === 403
                  ? "O YouTube recusou o download (403): o link do áudio expirou ou foi negado"
                  : upstream.status === 429
                    ? "O YouTube está limitando os downloads. Espere alguns minutos e tente de novo."
                    : `O YouTube respondeu ${upstream.status}`,
              retryable: true,
              kind: upstream.status === 429 ? "limit" : "temp",
            });
          return res.destroy();
        }
        if (!res.headersSent) {
          const total = new URL(target).searchParams.get("clen");
          res.writeHead(200, {
            "Content-Type":
              upstream.headers.get("content-type") ??
              "application/octet-stream",
            ...(total && { "Content-Length": total }),
            "Access-Control-Allow-Origin": "*",
          });
        }
        let got = 0;
        for await (const part of Readable.fromWeb(upstream.body)) {
          got += part.length;
          if (!res.write(part)) await new Promise((r) => res.once("drain", r));
        }
        if (got < CHUNK) break; // último pedaço
      }
      res.end();
    } catch (e) {
      console.error("Falha ao repassar o áudio", e);
      if (!res.headersSent)
        json(res, 502, { error: "Não consegui baixar o áudio" });
      else res.destroy();
    }
    return;
  }

  return json(res, 404, { error: "Rota não encontrada" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`resolver yfitops rodando em http://127.0.0.1:${PORT}`);
  console.log(`yt-dlp: ${BIN}  (defina YTDLP_PATH se não estiver no PATH)`);
});

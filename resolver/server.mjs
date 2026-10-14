import { createServer } from "node:http";
import { YtDlp } from "yt-dlp-wrap";

// ---------------------------------------------------------------------------
// Servidor "ajudante" do yfitops.
//
// Ele NÃO guarda música nenhuma. Ele só faz uma coisa: recebe um link de
// playlist e devolve a lista de faixas com a URL do áudio de cada uma.
// Quem baixa, converte, criptografa e sobe é o app (pipeline que já existe).
//
// Rode com:  npm start        (abre em http://127.0.0.1:8788)
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8788;
const BIN = process.env.YTDLP_PATH || "yt-dlp"; // caminho do yt-dlp, se não estiver no PATH

const ytDlp = new YtDlp(BIN);

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

/** Lê o ID da playlist de um link (o parâmetro `list=...`). */
function playlistId(url) {
  try {
    const u = new URL(url);
    const list = u.searchParams.get("list");
    return list && list.length > 1 ? list : null;
  } catch {
    return null;
  }
}

/**
 * Pede ao yt-dlp a lista "achatada" da playlist: título, artista e duração de
 * cada vídeo, sem baixar nada ainda. É rápido e barato.
 */
async function listPlaylist(id) {
  const info = await ytDlp.getVideoInfo(
    `https://www.youtube.com/playlist?list=${id}&--flat-playlist`,
    {
      dumpSingleJson: true,
      flatPlaylist: true,
      ignoreErrors: true,
      noWarnings: true,
    },
  );
  const entries = info?.entries ?? [];
  return entries
    .filter((e) => e && e.id)
    .map((e) => ({
      videoId: e.id,
      title: e.title ?? "Faixa sem título",
      // Em playlists de música o yt-dlp às vezes traz uploader/artista separado.
      artist: e.uploader ?? e.channel ?? e.artist ?? "",
      duration: e.duration ?? 0,
    }));
}

/**
 * Para um vídeo, devolve a URL direta do melhor áudio e também as tags.
 * `-f bestaudio` = só a faixa de áudio, no melhor formato disponível.
 * `-g` = "get URL" (não baixa; só imprime o endereço do stream).
 */
async function resolveTrack(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const streamUrl = (
    await ytDlp.execPromise([
      url,
      "-f",
      "bestaudio",
      "-g",
      "--no-warnings",
      "--no-playlist",
    ])
  )
    .trim()
    .split("\n")[0]; // pode vir vídeo+áudio separados; queremos a primeira (áudio)

  if (!streamUrl) throw new Error(`Sem áudio para ${videoId}`);

  // As tags detalhadas vêm num segundo passo (mais lento). Se falhar, seguimos
  // com o que a listagem já trouxe — por isso o try/catch.
  let title = "";
  let artist = "";
  try {
    const info = await ytDlp.getVideoInfo(url, {
      dumpSingleJson: true,
      skipDownload: true,
      noWarnings: true,
      noPlaylist: true,
    });
    title = info?.track || info?.title || "";
    artist = info?.artist || info?.uploader || info?.channel || "";
  } catch {
    /* sem tags detalhadas: o app tira o resto do nome do arquivo */
  }

  return { streamUrl, title, artist };
}

// --------------- HTTP ---------------

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

  // POST /resolve { url }  =>  { playlist, tracks: [{ videoId, title, artist, streamUrl }] }
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
    if (!isYouTube(url))
      return json(res, 400, { error: "Só aceitamos links do YouTube" });

    const list = playlistId(url);
    if (!list)
      return json(res, 400, {
        error: "Esse link não tem uma playlist (falta o parâmetro list=)",
      });

    try {
      const tracks = await listPlaylist(list);
      if (!tracks.length)
        return json(res, 404, { error: "A playlist está vazia ou é privada" });
      // Só a listagem: rápida e barata. O áudio de cada faixa vem pelo
      // /resolve/track, uma por vez, para o app mostrar progresso.
      return json(res, 200, { playlist: list, tracks });
    } catch (e) {
      console.error("Falha ao ler a playlist", e);
      return json(res, 502, { error: "Não consegui ler essa playlist agora" });
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
      return json(res, 502, {
        error: "Não consegui obter o áudio dessa faixa",
      });
    }
  }

  return json(res, 404, { error: "Rota não encontrada" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`resolver yfitops rodando em http://127.0.0.1:${PORT}`);
  console.log(`yt-dlp: ${BIN}  (defina YTDLP_PATH se não estiver no PATH)`);
});

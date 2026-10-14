import { ACCEPTED_EXT, enqueue } from "./importer";

// ---------------------------------------------------------------------------
// Importar playlist do YouTube.
//
// O app fala com o "resolver" (servidor Node separado), que devolve:
//   1) a lista de faixas da playlist;
//   2) para cada faixa, a URL do áudio.
//
// Aqui a gente baixa o áudio, transforma num `File` e joga no `enqueue` —
// o MESMO caminho de quando você arrasta arquivos. Dedupe, conversão,
// criptografia e upload continuam por conta do pipeline que já existe.
//
// Configure com VITE_RESOLVER_URL (ex.: http://127.0.0.1:8788).
// ---------------------------------------------------------------------------

const RESOLVER =
  (import.meta.env.VITE_RESOLVER_URL as string | undefined) ?? "http://127.0.0.1:8788";

export interface ResolvedTrack {
  videoId: string;
  title: string;
  artist: string;
  duration: number;
}

export interface ResolvedStream {
  videoId: string;
  streamUrl: string;
  title: string;
  artist: string;
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
    throw new Error("Não consegui falar com o servidor de importação. Ele está rodando?");
  }
  if (!res.ok) {
    let message = `O servidor respondeu ${res.status}`;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      /* corpo não-JSON */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/** Lista as músicas de uma playlist (rápido, não baixa áudio ainda). */
export function listPlaylist(url: string): Promise<ResolvedTrack[]> {
  return post<{ tracks: ResolvedTrack[] }>("/resolve", { url }).then((r) => r.tracks);
}

/** Obtém a URL do áudio de uma faixa. */
const resolveStream = (videoId: string) => post<ResolvedStream>("/resolve/track", { videoId });

const safeName = (s: string) => (s || "faixa").replace(/[\\/:*?"<>|]/g, "_").trim();

/**
 * Importa uma playlist inteira: para cada faixa, baixa o áudio como `File` e
 * entrega ao importador. Uma faixa por vez, para não estourar memória e para
 * o progresso fazer sentido.
 *
 * @param url    link da playlist do YouTube
 * @param onNote callback de status ("3 de 20 · baixando X...")
 * @returns quantas faixas entraram na fila
 */
export async function importPlaylist(url: string, onNote?: (note: string) => void): Promise<number> {
  onNote?.("lendo a playlist...");
  const tracks = await listPlaylist(url);
  if (!tracks.length) throw new Error("Essa playlist está vazia");

  let queued = 0;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const prefix = `${i + 1} de ${tracks.length}`;
    try {
      onNote?.(`${prefix} · obtendo áudio de "${t.title}"...`);
      const stream = await resolveStream(t.videoId);

      onNote?.(`${prefix} · baixando "${t.title}"...`);
      const blob = await fetch(stream.streamUrl).then((r) => {
        if (!r.ok) throw new Error(`download falhou (${r.status})`);
        return r.blob();
      });

      const artist = stream.artist || t.artist || "";
      const title = stream.title || t.title || `faixa ${i + 1}`;
      const base = artist ? `${artist} - ${title}` : title;
      // O importador reconhece pela extensão/tipo. O áudio do YouTube costuma
      // ser Opus (webm) ou AAC (m4a); o MediaRecorder/MIME interno já cuida.
      const ext = guessExt(blob.type);
      const name = `${safeName(base)}.${ext}`;
      const file = new File([blob], name, { type: blob.type || "audio/webm" });

      if (!ACCEPTED_EXT.test(name) && !/^(audio|video)\//.test(file.type)) {
        throw new Error("formato não reconhecido");
      }
      enqueue([file]);
      queued++;
    } catch (e) {
      onNote?.(`${prefix} · pulando "${t.title}": ${(e as Error).message}`);
    }
  }
  onNote?.(`${queued} música(s) enviada(s) para a biblioteca`);
  return queued;
}

function guessExt(mime: string): string {
  const m = mime.split(";")[0].trim();
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("webm") || m.includes("opus") || m.includes("ogg")) return "opus";
  if (m.includes("mpeg")) return "mp3";
  return "opus";
}

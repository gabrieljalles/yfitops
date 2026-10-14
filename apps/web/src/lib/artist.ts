// Descobrir o artista de uma música quando o arquivo não traz.
//
// Ordem: o que veio da origem (Spotify/YouTube) → "Artista - Título" no nome →
// busca pelo título no resolver (Spotify, Deezer, iTunes) → "Artista desconhecido".

import { resolverFetch } from "./resolverConn";

/** Quando nada encontrou o artista com segurança. */
export const UNKNOWN_ARTIST = "Artista desconhecido";

/** Canal "Artista - Topic" ou "ArtistaVEVO": aí o nome do canal é o artista. */
export function artistFromChannel(channel: string): string {
  const c = channel.trim();
  const topic = c.match(/^(.+?)\s+-\s+Topic$/i);
  if (topic) return topic[1];
  const vevo = c.match(/^(.+?)\s*VEVO$/);
  return vevo ? vevo[1] : "";
}

/** "Artista - Título (Official Video)" → { artist, title }; sem o separador, null. */
export function splitArtistTitle(text: string): { artist: string; title: string } | null {
  const m = text.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (!m) return null;
  const title = m[2].replace(/\s*[([][^)\]]*(official|video|audio|lyric|letra|clipe)[^)\]]*[)\]]/gi, "").trim();
  return { artist: m[1].trim(), title: title || m[2].trim() };
}

/**
 * Pergunta ao resolver quem canta essa música. Devolve "" se não achou com
 * segurança, ou se o resolver estiver desligado (aí fica "Artista desconhecido").
 */
export async function lookupArtist(title: string): Promise<string> {
  if (!title.trim()) return "";
  try {
    const r = await resolverFetch("/resolve/artist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!r.ok) return "";
    const { artist } = (await r.json()) as { artist?: string };
    return artist?.trim() ?? "";
  } catch {
    return "";
  }
}

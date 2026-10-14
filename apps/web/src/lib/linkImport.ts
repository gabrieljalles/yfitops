import { createStore } from "./observable";
import { libraryStore } from "./library";
import { ImportCancelled, importPlaylist, playlistSyncUrl, retryFailed as retryImport, videoInList, type ImportControl, type PlaylistResult, type ResolvedTrack } from "./resolver";
import { askNotifyPermission, notify } from "./notify";
import { toast } from "./ui";

// Estado da importação por link (YouTube/Spotify). Fica fora da tela de envio
// para não se perder quando a pessoa muda de tela: o download continua, e os
// avisos, o progresso e o resumo continuam lá quando ela voltar.

export interface LinkImportState {
  /** O que está digitado no campo (também sobrevive à troca de tela). */
  link: string;
  busy: boolean;
  /** Progresso atual ("3 de 20 · baixando X..."). */
  note: string;
  error: string;
  result: PlaylistResult | null;
  /** Lista sendo importada agora, a faixa em andamento e as que a pessoa mandou ignorar. */
  tracks: ResolvedTrack[];
  current: number;
  skipped: Set<ResolvedTrack>;
  /** Playlist esperando a pessoa dizer se as músicas ficam ligadas a ela. */
  ask: { name: string; count: number; truncated: boolean } | null;
  /** Link de um vídeo dentro de um mix/playlist: esperando "só esta" ou "a lista toda". */
  pick: { mix: boolean } | null;
  /** Playlist sendo sincronizada agora (id), para a tela dela mostrar o progresso. */
  syncing: string | null;
  /** Tags opcionais aplicadas a todas as músicas do link. */
  tags: string[];
}

export const linkImportStore = createStore<LinkImportState>({
  link: "",
  busy: false,
  note: "",
  error: "",
  result: null,
  tracks: [],
  current: 0,
  skipped: new Set(),
  ask: null,
  pick: null,
  syncing: null,
  tags: [],
});

const patch = (p: Partial<LinkImportState>) => linkImportStore.set((s) => ({ ...s, ...p }));
const setNote = (note: string) => patch({ note });

export const setImportLink = (link: string) => patch({ link });
export const setImportTags = (tags: string[]) => patch({ tags });
export const dismissImportResult = () => patch({ result: null });

/** Ignora (ou volta a incluir) uma faixa que ainda não foi baixada. */
export function toggleSkip(t: ResolvedTrack) {
  linkImportStore.set((s) => {
    const skipped = new Set(s.skipped);
    if (skipped.has(t)) skipped.delete(t);
    else skipped.add(t);
    return { ...s, skipped };
  });
}

/** Ignora todas as que ainda não começaram (cancela o resto da importação). */
export function skipAllPending() {
  linkImportStore.set((s) => ({
    ...s,
    skipped: new Set([...s.skipped, ...s.tracks.slice(s.current + 1)]),
  }));
}

/** Resolve a pergunta pendente com a resposta da pessoa (null = cancelou). */
let answerAsk: ((link: boolean | null) => void) | null = null;
/** Cancelada antes do primeiro download (vale para a importação em andamento). */
let cancelled = false;

/**
 * Cancela a importação antes de começar a baixar: enquanto lê o link ou
 * enquanto espera a resposta sobre a playlist. Nada é baixado nem criado.
 */
export function cancelLinkImport() {
  cancelled = true;
  answerAsk?.(null);
  answerAsk = null;
  answerPick?.(null);
  answerPick = null;
  patch({ ask: null, pick: null, note: "cancelando..." });
}

/** Resolve a escolha "só esta música" / "a lista toda" (null = cancelou). */
let answerPick: ((choice: "one" | "all" | null) => void) | null = null;

/** Responde se baixa só o vídeo do link ("one") ou o mix/playlist inteiro ("all"). */
export function answerLinkPick(choice: "one" | "all") {
  answerPick?.(choice);
  answerPick = null;
  patch({ pick: null });
}

/** Responde se as músicas da playlist ficam ligadas a ela (true) ou soltas (false). */
export function answerLinkAsk(link: boolean) {
  answerAsk?.(link);
  answerAsk = null;
  patch({ ask: null });
}

const control: ImportControl = {
  onList: (tracks) => patch({ tracks, current: 0 }),
  onProgress: (current) => patch({ current }),
  isSkipped: (t) => linkImportStore.get().skipped.has(t),
  isCancelled: () => cancelled,
  askLink: (ask) =>
    new Promise((resolve) => {
      answerAsk = resolve;
      patch({ ask, note: "" });
    }),
};

/**
 * Roda uma importação (uma por vez). `syncing` = id da playlist sendo
 * sincronizada: aí o campo de link e as tags da tela de envio não são tocados.
 */
async function run(work: () => Promise<PlaylistResult>, syncing: string | null = null): Promise<PlaylistResult | null> {
  if (linkImportStore.get().busy) return null;
  cancelled = false;
  void askNotifyPermission();
  patch({ busy: true, error: "", result: null, tracks: [], current: 0, skipped: new Set(), ask: null, pick: null, syncing });
  try {
    const result = await work();
    // Deu tudo certo: limpa o campo e as tags (elas eram desta importação).
    patch({ result, ...(!syncing && !result.failed.length && { link: "", tags: [] }) });
    const where = result.playlist ? ` em ${result.playlist.name}` : "";
    void notify(
      result.failed.length ? "Importação terminou com falhas" : syncing ? "Playlist sincronizada" : "Importação concluída",
      [
        `${result.imported.length} nova(s)${where}`,
        result.existing.length && `${result.existing.length} já estavam`,
        result.failed.length && `${result.failed.length} não puderam ser baixadas`,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    return result;
  } catch (e) {
    // Cancelada: não é erro. O link e as tags ficam no campo para tentar de novo.
    if (e instanceof ImportCancelled) toast("Importação cancelada. Nada foi baixado.");
    else {
      patch({ error: (e as Error).message });
      void notify("A importação parou", (e as Error).message);
    }
    return null;
  } finally {
    patch({ busy: false, note: "", tracks: [], skipped: new Set(), pick: null, syncing: null });
  }
}

/**
 * Sincroniza uma playlist importada: lê o link de origem de novo e baixa só as
 * músicas novas. As que já estão (pelo YouTube ou pelo Spotify/Deezer) não são
 * baixadas nem procuradas; as que saíram da origem continuam no app.
 */
export async function syncPlaylist(playlistId: string) {
  const p = libraryStore.get().playlists[playlistId];
  const url = p && playlistSyncUrl(p);
  if (!url) return;
  const result = await run(
    () => importPlaylist(url, setNote, { ...control, askLink: async () => true, tags: [] }),
    playlistId,
  );
  if (!result) return;
  const fresh = result.imported.length;
  toast(
    result.failed.length
      ? `${fresh} nova(s) · ${result.failed.length} não puderam ser baixadas (veja em Enviar)`
      : fresh
        ? `${fresh} música(s) nova(s) em ${p.name}`
        : `${p.name} já estava em dia`,
    result.failed.length ? "warn" : "ok",
  );
}

/** Importa o link que está no campo. */
export function startLinkImport() {
  const { link, tags } = linkImportStore.get();
  const url = link.trim();
  if (!url) return;
  // Copia as tags agora: mexer no campo durante o download não muda esta importação.
  const ctrl = { ...control, tags: [...tags] };
  void run(async () => {
    // Vídeo dentro de um mix/playlist: pergunta ANTES de ler a lista. Se for
    // só a música, nem pede a lista ao YouTube (um pedido a menos).
    let target = url;
    const both = videoInList(url);
    if (both) {
      const choice = await new Promise<"one" | "all" | null>((resolve) => {
        answerPick = resolve;
        patch({ pick: { mix: both.mix } });
      });
      if (choice === null) throw new ImportCancelled();
      if (choice === "one") target = both.single;
    }
    return importPlaylist(target, setNote, ctrl);
  });
}

/** Tenta de novo só as músicas que falharam na última importação. */
export function retryLinkImport() {
  const prev = linkImportStore.get().result;
  if (prev) void run(() => retryImport(prev, setNote, control));
}

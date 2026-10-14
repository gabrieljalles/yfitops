import { createStore } from "./observable";
import { importPlaylist, retryFailed as retryImport, type ImportControl, type PlaylistResult, type ResolvedTrack } from "./resolver";

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
});

const patch = (p: Partial<LinkImportState>) => linkImportStore.set((s) => ({ ...s, ...p }));
const setNote = (note: string) => patch({ note });

export const setImportLink = (link: string) => patch({ link });
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

const control: ImportControl = {
  onList: (tracks) => patch({ tracks, current: 0 }),
  onProgress: (current) => patch({ current }),
  isSkipped: (t) => linkImportStore.get().skipped.has(t),
};

async function run(work: () => Promise<PlaylistResult>) {
  if (linkImportStore.get().busy) return;
  patch({ busy: true, error: "", result: null, tracks: [], current: 0, skipped: new Set() });
  try {
    const result = await work();
    patch({ result, ...(!result.failed.length && { link: "" }) });
  } catch (e) {
    patch({ error: (e as Error).message });
  } finally {
    patch({ busy: false, note: "", tracks: [], skipped: new Set() });
  }
}

/** Importa o link que está no campo. */
export function startLinkImport() {
  const url = linkImportStore.get().link.trim();
  if (url) void run(() => importPlaylist(url, setNote, control));
}

/** Tenta de novo só as músicas que falharam na última importação. */
export function retryLinkImport() {
  const prev = linkImportStore.get().result;
  if (prev) void run(() => retryImport(prev, setNote, control));
}

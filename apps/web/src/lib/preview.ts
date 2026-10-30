import { api } from "./api";
import { createStore } from "./observable";
import { playerStore, toggle } from "./player";
import { toast } from "./ui";
import { BLOCKED_MESSAGE, isBlocked, isUnlocking, unlockAudio } from "./unlock";

// ---------------------------------------------------------------------------
// Prévia de 30 segundos (Deezer) das músicas do Descobrir: ouvir antes de pedir.
// Um player só para isso, fora da fila: tocar a prévia pausa a música, e dar
// play na música para a prévia.
// ---------------------------------------------------------------------------

export interface PreviewState {
  /** Id (Deezer) da música tocando a prévia, ou carregando. */
  id: string | null;
  loading: boolean;
}

export const previewStore = createStore<PreviewState>({ id: null, loading: false });

let audio: HTMLAudioElement | null = null;

function element(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "none";
  // O silêncio de destravar (Safari) não é a prévia.
  audio.addEventListener("ended", () => !isUnlocking(audio!) && previewStore.set({ id: null, loading: false }));
  audio.addEventListener("playing", () => !isUnlocking(audio!) && previewStore.set((s) => ({ ...s, loading: false })));
  // A música voltou a tocar (estava pausada e passou a tocar): a prévia para. Só na
  // virada: logo depois do pause() que a prévia pede, o player ainda diz "tocando"
  // por um instante, e isso não pode desligar a prévia que acabou de começar.
  let wasPlaying = playerStore.get().playing;
  playerStore.subscribe(() => {
    const playing = playerStore.get().playing;
    if (playing && !wasPlaying && previewStore.get().id) stopPreview();
    wasPlaying = playing;
  });
  return audio;
}

export function stopPreview() {
  audio?.pause();
  previewStore.set({ id: null, loading: false });
}

/** Toca a prévia (ou para, se já for ela). */
export async function togglePreview(id: string) {
  const a = element();
  if (previewStore.get().id === id) return stopPreview();
  a.pause();
  unlockAudio(a); // ainda no toque: o link da prévia só chega depois
  previewStore.set({ id, loading: true });
  if (playerStore.get().playing) toggle();
  try {
    // O link do Deezer expira em minutos: pede um novo na hora.
    const { url } = await api.json<{ url: string }>(`/discover/preview/${id}`);
    if (previewStore.get().id !== id) return;
    a.src = url;
    await a.play();
  } catch (e) {
    if (previewStore.get().id !== id) return;
    stopPreview();
    toast(isBlocked(e) ? BLOCKED_MESSAGE : (e as Error).message || "Não deu para tocar a prévia", "error");
  }
}

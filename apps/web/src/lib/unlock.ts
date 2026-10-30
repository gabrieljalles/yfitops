// ---------------------------------------------------------------------------
// Destravar o som no Safari (iPhone, iPad, Mac). Ele só deixa um <audio> tocar
// se o play() acontecer no instante de um toque; o app quase sempre busca algo
// antes (o arquivo da música, o link da prévia) e aí o toque "vence" e o Safari
// recusa ("play() can only be initiated by a user gesture"). A saída: no toque,
// cada <audio> toca um silêncio curtinho (mudo) e para. Daí em diante o Safari
// considera esse <audio> liberado e aceita o play() mesmo depois da espera.
// ---------------------------------------------------------------------------

/** 0,1 s de silêncio em WAV (8 bits, mono), montado aqui para não guardar arquivo. */
const SILENCE = (() => {
  const rate = 8000;
  const n = 800;
  const bytes = new Uint8Array(44 + n).fill(128, 44); // 128 = silêncio em 8 bits
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  text(36, "data");
  v.setUint32(40, n, true);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
})();

const unlocked = new WeakSet<HTMLAudioElement>();

/** Este <audio> está tocando o silêncio de destravar? (Os eventos dele não são música.) */
export const isUnlocking = (el: HTMLAudioElement) => el.src === SILENCE;

/**
 * Destrava um <audio>: chamar no instante do toque (antes de qualquer espera).
 * Só mexe em quem ainda não tocou nada: um <audio> com música carregada já toca
 * direto pelo botão de play.
 */
export function unlockAudio(el: HTMLAudioElement) {
  if (unlocked.has(el) || el.getAttribute("src")) return;
  unlocked.add(el);
  const muted = el.muted;
  el.muted = true;
  el.src = SILENCE;
  el.play()
    .then(() => el.src === SILENCE && el.pause())
    // Interrompido porque a música chegou logo em seguida: o toque já valeu.
    .catch((e) => (e as Error)?.name === "NotAllowedError" && unlocked.delete(el))
    .finally(() => {
      if (el.src === SILENCE) el.removeAttribute("src");
      el.muted = muted;
    });
}

/** Destrava estes <audio> no primeiro toque (ou tecla) em qualquer lugar do app. */
export function unlockOnTouch(els: HTMLAudioElement[]) {
  const events = ["touchend", "click", "keydown"] as const;
  const onTouch = () => {
    els.forEach(unlockAudio);
    if (els.every((el) => unlocked.has(el))) events.forEach((e) => document.removeEventListener(e, onTouch, true));
  };
  events.forEach((e) => document.addEventListener(e, onTouch, true));
}

/** O navegador recusou tocar sem um toque (Safari). */
export const isBlocked = (e: unknown) => (e as Error)?.name === "NotAllowedError";

export const BLOCKED_MESSAGE = "O navegador bloqueou o som. Toque de novo para ouvir.";

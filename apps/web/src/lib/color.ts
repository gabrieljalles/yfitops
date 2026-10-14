// Cor predominante de uma capa, para pintar o rótulo do vinil que sai dela.

const cache = new Map<string, Promise<string | null>>();

/**
 * Lê a capa numa miniatura de 32×32 e agrupa os pixels por tom. Pixels quase
 * pretos, quase brancos ou cinzentos contam pouco: senão quase toda capa daria
 * "preto" ou "branco", e o rótulo some no vinil. Devolve `rgb(...)` ou null.
 */
export function dominantColor(key: string, src: string): Promise<string | null> {
  let hit = cache.get(key);
  if (!hit) {
    hit = compute(src).catch(() => null);
    cache.set(key, hit);
  }
  return hit;
}

async function compute(src: string): Promise<string | null> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, size, size);
  return pickColor(ctx.getImageData(0, 0, size, size).data);
}

/** Escolhe a cor predominante a partir dos pixels RGBA. */
export function pickColor(data: Uint8ClampedArray | Uint8Array): string | null {
  // Baldes de 3 bits por canal (512 cores); cada um soma peso e as cores reais.
  const buckets = new Map<number, { w: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 128) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const light = (max + min) / 2 / 255;
    // Peso: cores vivas valem muito mais que tons neutros (cinza, preto, branco),
    // que só vencem quando a capa não tem cor nenhuma.
    // Entre as vivas, as de brilho médio valem mais que as muito escuras.
    const w = sat < 0.2 || light < 0.1 || light > 0.94 ? 0.01 : sat * (1.2 - Math.abs(light - 0.5) * 2);
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bk = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0 };
    bk.w += w;
    bk.r += r * w;
    bk.g += g * w;
    bk.b += b * w;
    buckets.set(key, bk);
  }
  let best: { w: number; r: number; g: number; b: number } | null = null;
  for (const bk of buckets.values()) if (!best || bk.w > best.w) best = bk;
  if (!best || best.w === 0) return null;
  return visible(best.r / best.w, best.g / best.w, best.b / best.w);
}

/**
 * Mantém o tom, mas garante brilho entre 45% e 72%: muito escura a cor some no
 * vinil preto; muito clara vira quase branco.
 */
function visible(r: number, g: number, b: number): string {
  const [h, s, l] = toHsl(r / 255, g / 255, b / 255);
  const L = Math.min(0.72, Math.max(0.45, l));
  return `hsl(${Math.round(h * 360)} ${Math.round(Math.max(s, 0) * 100)}% ${Math.round(L * 100)}%)`;
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

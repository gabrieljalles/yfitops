const DAY = 1000 * 60 * 60 * 24;

/** A partir de quantos dias antes do vencimento o aviso aparece. */
export const WARN_DAYS = 7;

/** Dias inteiros até vencer (0 = vence hoje; negativo = já venceu). */
export const daysLeft = (paidUntil: number, now = Date.now()) => Math.ceil((paidUntil - now) / DAY);

/** "hoje", "amanhã", "em 5 dias". */
export function dueText(paidUntil: number, now = Date.now()): string {
  const d = daysLeft(paidUntil, now);
  return d <= 0 ? "hoje" : d === 1 ? "amanhã" : `em ${d} dias`;
}

export const formatDate = (ms: number) => new Date(ms).toLocaleDateString("pt-BR");

/** +5511987654321 → (11) 98765-4321; números de fora do Brasil ficam como estão. */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : phone;
}

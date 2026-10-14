import { createStore } from "./observable";

// Diálogos do próprio app, no lugar do confirm()/prompt() do navegador (que
// mostram "localhost:5173 diz" e não seguem o visual do app). Cada chamada
// devolve uma Promise que resolve quando a pessoa responde.

export interface DialogRequest {
  title: string;
  message?: string;
  /** Texto do botão de confirmar (padrão: "ok"). */
  confirm?: string;
  /** Ação destrutiva (excluir, apagar, sair): botão vermelho e foco no "cancelar". */
  danger?: boolean;
  /** Pede um texto (como o prompt()). */
  input?: { placeholder?: string; value?: string; type?: "text" | "email" };
}

interface OpenDialog extends DialogRequest {
  resolve: (value: string | null) => void;
}

export const dialogStore = createStore<OpenDialog | null>(null);

function open(req: DialogRequest): Promise<string | null> {
  // Um diálogo novo cancela o anterior (não deveria acontecer, mas não trava).
  dialogStore.get()?.resolve(null);
  return new Promise((resolve) => dialogStore.set({ ...req, resolve }));
}

/** Fecha o diálogo aberto com a resposta (null = cancelou). */
export function answerDialog(value: string | null) {
  const d = dialogStore.get();
  if (!d) return;
  dialogStore.set(null);
  d.resolve(value);
}

/** Pergunta sim/não. true = confirmou. */
export async function confirmDialog(req: Omit<DialogRequest, "input">): Promise<boolean> {
  return (await open(req)) !== null;
}

/** Pede um texto. Devolve o texto sem espaços nas pontas, ou null se cancelou/deixou vazio. */
export async function promptDialog(req: DialogRequest): Promise<string | null> {
  const value = await open({ ...req, input: req.input ?? {} });
  return value?.trim() || null;
}

import { Vinyl } from "./Cover";

/** amarelo = falta algo · vermelho = erro · verde = deu certo */
export type Tone = "warn" | "error" | "ok";

/** Aviso minimalista: um mini vinil com o rótulo na cor do tom, que gira ao aparecer. */
export function Notice({ tone, children, id }: { tone: Tone; children: React.ReactNode; id?: string }) {
  return (
    <div className={`notice ${tone}`} role={tone === "error" ? "alert" : "status"} id={id}>
      <span className="notice-disc">
        <Vinyl seed="" mini label={`var(--tone-${tone})`} />
      </span>
      <span>{children}</span>
    </div>
  );
}

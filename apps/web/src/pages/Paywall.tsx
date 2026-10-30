import { useState } from "react";
import { Vinyl } from "../components/Cover";
import { Notice, type Tone } from "../components/Notice";
import { brl, formatDate } from "../lib/billing";
import { isExpired, logout, refreshAccount, sessionStore, type Session } from "../lib/session";

/** Acesso vencido: no lugar do app, só as instruções de pagamento. A biblioteca continua guardada. */
export function PaywallPage({ session }: { session: Session }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: Tone; message: string } | null>(null);

  const check = async () => {
    setBusy(true);
    setNote(null);
    await refreshAccount();
    setBusy(false);
    if (isExpired(sessionStore.get())) {
      setNote({ tone: "warn", message: "Ainda não foi liberado. Assim que o pagamento for confirmado, é só tocar aqui de novo." });
    }
  };

  return (
    <main className="auth paywall">
      <div className="auth-logo">
        <Vinyl seed="" label="var(--tone-warn)" />
      </div>
      <h1>Seu acesso venceu</h1>
      <p className="muted">
        O acesso terminou em {formatDate(session.paidUntil ?? 0)}. Suas músicas e playlists continuam guardadas e voltam assim que o
        pagamento for confirmado.
      </p>
      {session.priceCents !== undefined && <p className="payment-info">Mensalidade: {brl(session.priceCents)}</p>}
      {session.paymentInfo && <p className="payment-info">{session.paymentInfo}</p>}
      {note && <Notice tone={note.tone}>{note.message}</Notice>}
      <button className="primary" disabled={busy} onClick={() => void check()}>
        {busy ? "verificando…" : "Já paguei, verificar"}
      </button>
      <nav className="auth-links">
        <button onClick={() => void logout()}>Sair da conta</button>
      </nav>
    </main>
  );
}

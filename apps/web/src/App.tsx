import { lazy, Suspense, useEffect, useState } from "react";
import { Vinyl } from "./components/Cover";
import { Dialog } from "./components/Dialog";
import { Icon, type IconName } from "./components/Icon";
import { Notice } from "./components/Notice";
import { SyncButton } from "./components/SyncButton";
import { InstallAppBanner, InstallAppPrompt } from "./components/InstallApp";
import { FullPlayer, PlayerBar } from "./components/Player";
import { TrackSheet } from "./components/TrackSheet";
import { brl, daysLeft, dueText, formatDate, WARN_DAYS } from "./lib/billing";
import { keepLocalData, loadOfflineIndex } from "./lib/blobs";
import { reconcileMerges } from "./lib/catalog";
import { jobsStore } from "./lib/importer";
import { libraryStore, loadLocal, resetLibrary, sync } from "./lib/library";
import { useStore } from "./lib/observable";
import { playerStore, stop } from "./lib/player";
import { isExpired, pendingRequestsStore, refreshAccount, saveInvite, sessionStore } from "./lib/session";
import { uiStore } from "./lib/ui";
import { AuthPage, PendingPage, ResetPage } from "./pages/Auth";
import { FavoritesPage, GroupPage } from "./pages/Group";
import { HomePage } from "./pages/Home";
import { LibraryPage } from "./pages/Library";
import { PaywallPage } from "./pages/Paywall";
import { SettingsPage } from "./pages/Settings";
import { DiscoverPage } from "./pages/Discover";
import { navigate, useRoute } from "./router";
import { finished, importsStore, stopImports, watchImports } from "./lib/imports";
import { startSpot } from "./lib/spot";

// Painel administrativo: só é baixado por quem é administrador.
const AdminPage = lazy(() => import("./pages/Admin"));

const NAV: [string, string, IconName][] = [
  ["", "Início", "home"],
  ["descobrir", "Descobrir", "compass"],
  ["biblioteca", "Biblioteca", "library"],
  ["ajustes", "Ajustes", "settings"],
];

/** Relógio que avança a cada minuto (o acesso pode vencer com o app aberto, até offline). */
function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function App() {
  const session = useStore(sessionStore);
  const { parts, query } = useRoute();
  const now = useMinuteClock();

  const pending = session?.status === "pending";
  const expired = isExpired(session, now);

  // Link de convite (#/convite/CÓDIGO): guarda o código para o cadastro e abre o início.
  // Guarda já aqui (e não num efeito) para a tela de entrar já abrir em "criar conta".
  const invite = parts[0] === "convite" ? parts[1] : undefined;
  if (invite) saveInvite(invite);
  useEffect(() => {
    if (invite) navigate("/");
  }, [invite]);

  useEffect(() => {
    if (!session || pending) {
      resetLibrary();
      return;
    }
    void refreshAccount();
    // Depois do sync: músicas que a faxina do servidor juntou (ou que o
    // administrador apagou) acompanham aqui também (no máximo a cada 6 h).
    const syncAll = () => sync().then(() => reconcileMerges().catch(() => {}));
    void loadLocal().then(syncAll);
    void loadOfflineIndex();
    void keepLocalData();
    // Pedidos por link: as músicas prontas entram na biblioteca. No app Android,
    // este celular também ajuda a baixar (no Wi-Fi, com o app aberto ou tocando).
    watchImports();
    startSpot();
    // Economia de requisições: o que você muda vai na hora (saveItem); buscar o
    // que mudou em outro aparelho é a cada 5 min com o app aberto e na tela, ou
    // ao voltar para o app (se o último sync tiver mais de 1 min).
    const stale = (ms: number) => Date.now() - (libraryStore.get().lastSync ?? 0) > ms;
    const onFocus = () => document.visibilityState === "visible" && stale(60_000) && void syncAll();
    const onOnline = () => void syncAll();
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void syncAll();
      // Pedidos de acesso (administrador) e vencimento do pagamento (todos).
      void refreshAccount();
    }, 5 * 60_000);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(interval);
      stopImports();
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [session?.userId, pending]);

  // Venceu com música tocando (inclusive offline): para na hora.
  useEffect(() => {
    if (expired) stop();
  }, [expired]);

  // Avisa antes de fechar com envios em andamento.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (jobsStore.get().some((j) => ["na fila", "lendo", "convertendo", "enviando"].includes(j.status))) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  if (parts[0] === "redefinir" && query.get("token")) return <ResetPage token={query.get("token")!} />;
  if (session === undefined) return null;
  if (!session) return <AuthPage />;
  if (pending) return <PendingPage />;
  if (expired) return <PaywallPage session={session} />;

  return (
    <Shell section={{ buscar: "biblioteca", enviar: "descobrir" }[parts[0] ?? ""] ?? parts[0] ?? ""}>
      {(() => {
        switch (parts[0]) {
          case "buscar": // a busca agora fica na Biblioteca (links antigos)
          case "biblioteca":
            return <LibraryPage key={query.get("tag") ?? ""} initialTag={query.get("tag") ?? undefined} />;
          case "descobrir":
          case "enviar": // nome antigo do Descobrir
            return <DiscoverPage />;
          case "ajustes":
            return <SettingsPage />;
          case "playlist":
          case "grupo": // links antigos
            return <GroupPage id={parts[1]} />;
          case "favoritas":
            return <FavoritesPage />;
          case "admin":
            // Para quem não é administrador, o endereço só abre o início.
            if (session.admin)
              return (
                <Suspense fallback={<div className="page muted">Carregando…</div>}>
                  <AdminPage />
                </Suspense>
              );
            return <HomePage />;
          default:
            return <HomePage />;
        }
      })()}
    </Shell>
  );
}

function Shell({ section, children }: { section: string; children: React.ReactNode }) {
  const player = useStore(playerStore);
  const jobs = useStore(jobsStore);
  const uploading = jobs.filter((j) => !["pronto", "já existe", "erro"].includes(j.status)).length;
  const imports = useStore(importsStore);
  /** Links pedidos que ainda não terminaram. */
  const waiting = imports.requests.filter((r) => !finished(r)).length;
  const session = useStore(sessionStore);
  const requests = useStore(pendingRequestsStore);
  const nav: [string, string, IconName][] = session?.admin ? [...NAV, ["admin", "Painel", "shield"]] : NAV;

  return (
    <div className={`app${player.index >= 0 ? " has-player" : ""}`}>
      <nav className="nav">
        <Brand playing={player.playing} />
        {nav.map(([path, label, icon]) => (
          <button key={path} className={section === path ? "on" : ""} onClick={() => navigate(`/${path}`)}>
            <Icon name={icon} />
            <span>{label}</span>
            {path === "descobrir" && (uploading > 0 || waiting > 0) && (
              <span className="dot" title={waiting ? `${waiting} link(s) esperando na fila` : undefined}>
                {uploading || waiting}
              </span>
            )}
            {path === "admin" && requests > 0 && (
              <span className="dot">
                {requests}
              </span>
            )}
          </button>
        ))}
        {/* Estado do sync sempre à vista: "tudo salvo", "3 para enviar", "offline"... */}
        <div className="sync-state">
          <SyncButton />
        </div>
      </nav>
      <main className="content">
        <header className="mobile-brand">
          <Brand playing={player.playing} />
          <SyncButton className="compact" />
        </header>
        <PaymentBanner />
        <InstallAppBanner />
        {children}
      </main>
      <PlayerBar />
      <FullPlayer />
      <TrackSheet />
      <Toast />
      <Dialog />
      <InstallAppPrompt />
    </div>
  );
}

/** Aviso de vencimento próximo, com o jeito de pagar. */
function PaymentBanner() {
  const session = useStore(sessionStore);
  if (session?.paidUntil === undefined || daysLeft(session.paidUntil) > WARN_DAYS) return null;
  return (
    <div className="access-banner">
      <Notice tone="warn">
        Seu acesso vence {dueText(session.paidUntil)} ({formatDate(session.paidUntil)}).
        {session.priceCents !== undefined && ` Mensalidade: ${brl(session.priceCents)}.`} {session.paymentInfo}
      </Notice>
    </div>
  );
}

/** Nome do app com o vinil da marca girando (mais rápido quando há música tocando). */
function Brand({ playing }: { playing: boolean }) {
  return (
    <div className="brand">
      <span className={`brand-disc${playing ? " playing" : ""}`}>
        <Vinyl seed="" mini label="var(--brand)" groove="#ffffff" spinning />
      </span>
      yfitops
    </div>
  );
}

function Toast() {
  const { toast } = useStore(uiStore);
  return toast ? (
    <div className="toast" key={toast.message}>
      <Notice tone={toast.tone}>{toast.message}</Notice>
    </div>
  ) : null;
}

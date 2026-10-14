import { useEffect } from "react";
import { Vinyl } from "./components/Cover";
import { Dialog } from "./components/Dialog";
import { Icon, type IconName } from "./components/Icon";
import { Notice } from "./components/Notice";
import { SyncButton } from "./components/SyncButton";
import { FullPlayer, PlayerBar } from "./components/Player";
import { TrackSheet } from "./components/TrackSheet";
import { loadOfflineIndex } from "./lib/blobs";
import { reconcileMerges } from "./lib/catalog";
import { jobsStore } from "./lib/importer";
import { loadLocal, resetLibrary, sync } from "./lib/library";
import { useStore } from "./lib/observable";
import { playerStore } from "./lib/player";
import { sessionStore } from "./lib/session";
import { uiStore } from "./lib/ui";
import { AuthPage, ResetPage } from "./pages/Auth";
import { FavoritesPage, GroupPage, SharedGroupPage } from "./pages/Group";
import { HomePage } from "./pages/Home";
import { LibraryPage } from "./pages/Library";
import { SearchPage } from "./pages/Search";
import { SettingsPage } from "./pages/Settings";
import { UploadPage } from "./pages/Upload";
import { navigate, useRoute } from "./router";
import { linkImportStore } from "./lib/linkImport";

const NAV: [string, string, IconName][] = [
  ["", "Início", "home"],
  ["buscar", "Buscar", "search"],
  ["biblioteca", "Biblioteca", "library"],
  ["enviar", "Enviar", "upload"],
  ["ajustes", "Ajustes", "settings"],
];

export function App() {
  const session = useStore(sessionStore);
  const { parts, query } = useRoute();

  useEffect(() => {
    if (!session) {
      resetLibrary();
      return;
    }
    // Depois do sync: músicas que a faxina do servidor juntou viram uma só aqui também (no máximo a cada 6 h).
    const syncAll = () => sync().then(() => reconcileMerges().catch(() => {}));
    void loadLocal().then(syncAll);
    void loadOfflineIndex();
    const onFocus = () => document.visibilityState === "visible" && void syncAll();
    const onOnline = () => void syncAll();
    const interval = setInterval(() => void syncAll(), 60_000);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [session?.userId]);

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

  return (
    <Shell section={parts[0] ?? ""}>
      {(() => {
        switch (parts[0]) {
          case "buscar":
            return <SearchPage key={query.get("tag") ?? ""} initialTag={query.get("tag") ?? undefined} />;
          case "biblioteca":
            return <LibraryPage />;
          case "enviar":
            return <UploadPage />;
          case "ajustes":
            return <SettingsPage />;
          case "playlist":
          case "grupo": // links antigos
            return <GroupPage id={parts[1]} />;
          case "compartilhado":
            return <SharedGroupPage shareId={parts[1]} />;
          case "favoritas":
            return <FavoritesPage />;
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
  const linkImport = useStore(linkImportStore);

  return (
    <div className={`app${player.index >= 0 ? " has-player" : ""}`}>
      <nav className="nav">
        <Brand playing={player.playing} />
        {NAV.map(([path, label, icon]) => (
          <button key={path} className={section === path ? "on" : ""} onClick={() => navigate(`/${path}`)}>
            <Icon name={icon} />
            <span>{label}</span>
            {path === "enviar" && (uploading > 0 || linkImport.busy) && (
              // Importando por link: o ponto aparece mesmo antes de a 1ª música entrar na fila.
              <span className="dot" title={linkImport.note || undefined}>
                {uploading || "…"}
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
        {children}
      </main>
      <PlayerBar />
      <FullPlayer />
      <TrackSheet />
      <Toast />
      <Dialog />
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

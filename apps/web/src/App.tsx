import { useEffect } from "react";
import { Vinyl } from "./components/Cover";
import { Icon, type IconName } from "./components/Icon";
import { Notice } from "./components/Notice";
import { FullPlayer, PlayerBar } from "./components/Player";
import { TrackSheet } from "./components/TrackSheet";
import { loadOfflineIndex } from "./lib/blobs";
import { jobsStore } from "./lib/importer";
import { libraryStore, loadLocal, resetLibrary, sync } from "./lib/library";
import { useStore } from "./lib/observable";
import { playerStore } from "./lib/player";
import { sessionStore } from "./lib/session";
import { uiStore } from "./lib/ui";
import { AuthPage, ResetPage } from "./pages/Auth";
import { GroupPage, SharedGroupPage } from "./pages/Group";
import { HomePage } from "./pages/Home";
import { LibraryPage } from "./pages/Library";
import { SearchPage } from "./pages/Search";
import { SettingsPage } from "./pages/Settings";
import { UploadPage } from "./pages/Upload";
import { navigate, useRoute } from "./router";

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
    void loadLocal().then(() => sync());
    void loadOfflineIndex();
    const onFocus = () => document.visibilityState === "visible" && void sync();
    const onOnline = () => void sync();
    const interval = setInterval(() => void sync(), 60_000);
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
          case "grupo":
            return <GroupPage id={parts[1]} />;
          case "compartilhado":
            return <SharedGroupPage shareId={parts[1]} />;
          default:
            return <HomePage />;
        }
      })()}
    </Shell>
  );
}

function Shell({ section, children }: { section: string; children: React.ReactNode }) {
  const player = useStore(playerStore);
  const lib = useStore(libraryStore);
  const jobs = useStore(jobsStore);
  const uploading = jobs.filter((j) => !["pronto", "já existe", "erro"].includes(j.status)).length;

  return (
    <div className={`app${player.index >= 0 ? " has-player" : ""}`}>
      <nav className="nav">
        <Brand playing={player.playing} />
        {NAV.map(([path, label, icon]) => (
          <button key={path} className={section === path ? "on" : ""} onClick={() => navigate(`/${path}`)}>
            <Icon name={icon} />
            <span>{label}</span>
            {path === "enviar" && uploading > 0 && <span className="dot">{uploading}</span>}
          </button>
        ))}
        <div className="sync-state muted small" title={lib.error ?? ""}>
          {!navigator.onLine ? "offline" : lib.syncing ? "sincronizando…" : lib.error ? "erro no sync" : ""}
        </div>
      </nav>
      <main className="content">
        <header className="mobile-brand">
          <Brand playing={player.playing} />
        </header>
        {children}
      </main>
      <PlayerBar />
      <FullPlayer />
      <TrackSheet />
      <Toast />
    </div>
  );
}

/** Nome do app com o vinil da marca girando (mais rápido quando há música tocando). */
function Brand({ playing }: { playing: boolean }) {
  return (
    <div className="brand">
      <span className={`brand-disc${playing ? " playing" : ""}`}>
        <Vinyl seed="" mini label="var(--brand)" spinning />
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

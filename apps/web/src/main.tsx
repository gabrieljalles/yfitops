import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { setImportLink } from "./lib/imports";
import { applyPrefs } from "./lib/prefs";
import { restoreSession } from "./lib/session";
import "./styles.css";

// Antes de desenhar: evita piscar o tema escuro para quem usa o claro.
applyPrefs();
receiveSharedLink();
void restoreSession();

/**
 * Link compartilhado pelo menu "Compartilhar" do celular (app instalado):
 * chega como /?share_url=...&share_text=... e vai para o campo da tela de envio.
 * Não começa sozinho: a pessoa confere e toca em "importar".
 */
function receiveSharedLink() {
  const q = new URLSearchParams(location.search);
  if (!["share_url", "share_text", "share_title"].some((k) => q.has(k))) return;
  // YouTube/Spotify costumam mandar o link dentro do texto ("Ouça X: https://...").
  const text = ["share_url", "share_text", "share_title"].map((k) => q.get(k) ?? "").join(" ");
  const link = text.match(/https?:\/\/\S+/)?.[0];
  history.replaceState(null, "", "/#/enviar");
  if (link) setImportLink(link);
}

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

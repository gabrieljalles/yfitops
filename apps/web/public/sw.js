// Service worker mínimo: guarda o "casco" do app para abrir offline.
// Os áudios ficam no IndexedDB (criptografados), não aqui.
const CACHE = "yfitops-shell-v3";

// Tocar no aviso de "importação concluída": abre (ou traz para frente) o app na tela de envio.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => new URL(w.url).origin === location.origin);
      if (win) return win.focus().then((w) => w && w.navigate ? w.navigate("/#/enviar") : undefined);
      return self.clients.openWindow("/#/enviar");
    }),
  );
});

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Rede primeiro; se offline, usa o cache (e o index.html para navegação).
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(e.request)) || (e.request.mode === "navigate" ? caches.match("/") : Response.error())),
  );
});

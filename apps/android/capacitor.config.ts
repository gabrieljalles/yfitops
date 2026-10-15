import type { CapacitorConfig } from "@capacitor/cli";

// O app abre o yfitops publicado (o mesmo site): atualizar o site atualiza o app.
// Para testar no emulador contra o servidor local: YFITOPS_APP_URL=http://localhost:8790
const PROD = "https://yfitops.gabriel-jalleswork.workers.dev";
const test = process.env.YFITOPS_APP_URL;

const config: CapacitorConfig = {
  appId: "dev.yfitops.app",
  appName: "Yfitops",
  webDir: "www",
  server: {
    url: test || PROD,
    errorPath: "offline.html",
    ...(test && { cleartext: true }),
  },
  android: {
    backgroundColor: "#000000",
    // Só no build de teste: deixa inspecionar a página pelo computador.
    webContentsDebuggingEnabled: !!test,
  },
};

export default config;

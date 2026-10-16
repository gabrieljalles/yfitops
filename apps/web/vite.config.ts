import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Versão deste build: o app compara com /version.json do servidor para avisar que há atualização.
const version = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

export default defineConfig({
  plugins: [
    react(),
    {
      name: "app-version",
      apply: "build",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version }) });
      },
    },
  ],
  define: { __APP_VERSION__: JSON.stringify(version) },
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  build: { target: "es2022" },
});

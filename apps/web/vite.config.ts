import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  build: { target: "es2022" },
});

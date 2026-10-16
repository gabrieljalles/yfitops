// Antes de publicar: o APK fica fora do git (apps/web/public/yfitops.apk, gerado por
// apps/android/build-apk.mjs). Publicar sem ele tira o app Android do ar.
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const apk = fileURLToPath(new URL("../apps/web/dist/yfitops.apk", import.meta.url));
if (!existsSync(apk) || statSync(apk).size < 100_000) {
  console.error("\n✖ Deploy cancelado: falta o APK (apps/web/public/yfitops.apk).");
  console.error("  Gere com `node apps/android/build-apk.mjs` ou copie da pasta onde ele já existe.\n");
  process.exit(1);
}

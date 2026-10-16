import { _android, chromium } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// O app Android de verdade (no emulador) ajudando a fila. Precisa:
//   - servidor local:   npx wrangler dev --port 8790   (em server/)
//   - APK de teste:     YFITOPS_APP_URL=http://localhost:8790 npx cap sync android && gradlew assembleDebug
//   - emulador "yfitops-teste" (Android 35) em ANDROID_DEV/sdk
//
// O computador pede um link; o app no emulador lê o link e procura as músicas no
// YouTube pela conexão nativa (sem CORS). O áudio é o de teste (o YouTube costuma
// barrar o computador de quem testa muito), a não ser com REAL_DOWNLOAD=1.
//
//   node scripts/e2e-android.mjs [pasta-das-capturas]
const OUT = process.argv[2] ?? "e2e-shots";
mkdirSync(OUT, { recursive: true });
const DEV = process.env.ANDROID_DEV ?? join(homedir(), "android-dev");
const SDK = join(DEV, "sdk");
const ADB = join(SDK, "platform-tools", "adb.exe");
const APK = fileURLToPath(new globalThis.URL("../apps/android/android/app/build/outputs/apk/debug/app-debug.apk", import.meta.url));
const URL = process.env.APP_URL ?? "http://127.0.0.1:8790/";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const LINK = process.env.QUEUE_LINK ?? "https://www.deezer.com/album/213539402";

const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8" }).trim();
/** Captura da tela do emulador (o modo Android do Playwright não tira foto do WebView). */
const screen = (name) => writeFileSync(join(OUT, `${name}.png`), execFileSync(ADB, ["exec-out", "screencap", "-p"], { maxBuffer: 64 << 20 }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log("→", s);

function wav(seconds = 40, rate = 8000) {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(0.3 * Math.sin((2 * Math.PI * 440 * i) / rate) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function signup(p, email, base) {
  await p.goto(base);
  await p.getByRole("button", { name: "Criar conta" }).click();
  await p.getByLabel("E-mail").fill(email);
  await p.getByLabel("Senha", { exact: true }).fill("minha-senha-123");
  await p.getByLabel("Repita a senha").fill("minha-senha-123");
  const res = p.waitForResponse((r) => r.url().includes("/api/auth/signup/start"));
  await p.locator("form").getByRole("button", { name: "Continuar" }).click();
  const { devCode } = await (await res).json();
  await p.getByLabel("Código de 6 números").fill(devCode);
  await p.locator("form").getByRole("button", { name: "Criar conta" }).click();
  await p.getByText("Sua estante está vazia").waitFor({ timeout: 60000 });
}

let emulator;
let failed = false;
const pc = await chromium.launch({ executablePath: CHROME });
try {
  step("ligando o emulador");
  const booted = (() => {
    try {
      return adb("shell", "getprop", "sys.boot_completed") === "1";
    } catch {
      return false;
    }
  })();
  if (!booted) {
    emulator = spawn(join(SDK, "emulator", "emulator.exe"), ["-avd", "yfitops-teste", "-no-window", "-no-audio", "-no-snapshot", "-no-boot-anim", "-gpu", "swiftshader_indirect"], {
      stdio: "ignore",
      detached: true,
    });
    adb("wait-for-device");
    for (let i = 0; i < 180; i++) {
      try {
        if (adb("shell", "getprop", "sys.boot_completed") === "1") break;
      } catch {
        /* ainda ligando */
      }
      await sleep(2000);
    }
  }
  console.log("    Android", adb("shell", "getprop", "ro.build.version.release"));

  step("instalando e abrindo o app");
  adb("install", "-r", "-g", APK);
  adb("shell", "am", "force-stop", "dev.yfitops.app");
  adb("shell", "pm", "clear", "dev.yfitops.app");
  // localhost (e não 10.0.2.2): só endereço seguro tem a criptografia do navegador.
  adb("reverse", "tcp:8790", "tcp:8790");
  // O "pm clear" tira as permissões: a da notificação "tocando" volta já concedida.
  adb("shell", "pm", "grant", "dev.yfitops.app", "android.permission.POST_NOTIFICATIONS");
  adb("shell", "am", "start", "-n", "dev.yfitops.app/.MainActivity");
  // O Playwright fala com o WebView do app pelo adb (modo Android).
  const [device] = await _android.devices();
  if (!device) throw new Error("O adb não achou o emulador");
  const webview = await device.webView({ pkg: "dev.yfitops.app" }, { timeout: 60000 });
  const phone = await webview.page();
  await phone.waitForURL(/localhost:8790/, { timeout: 30000 });
  globalThis.phone = phone;
  phone.on("console", (m) => m.type() === "error" && console.log("    [app]", m.text()));
  const native = await phone.evaluate(() => ({
    native: window.Capacitor?.isNativePlatform?.(),
    plugins: Object.keys(window.Capacitor?.Plugins ?? {}),
  }));
  console.log("    dentro do app:", JSON.stringify(native));
  if (!native.native) throw new Error("O site abriu sem a ponte do app (Capacitor)");

  const run = Date.now().toString(36);
  const base = "http://localhost:8790/";
  if (!process.env.REAL_DOWNLOAD)
    await phone.evaluate((a) => {
      localStorage.setItem("yfitops.spot-debug", "1");
      localStorage.setItem("yfitops.spot-test-audio", a);
    }, `data:audio/wav;base64,${wav().toString("base64")}`);
  await signup(phone, `celular-${run}@teste.com`, base);
  await phone.goto(base + "#/ajustes");
  await phone.getByText("Este celular ajuda a baixar").waitFor();
  const status = async () => (await phone.locator('[role="status"]').innerText().catch(() => "")).trim();
  await sleep(2500);
  console.log("    celular:", await status());
  screen("a01-ajustes-no-app");

  step("o computador pede um link; o app no emulador baixa");
  const desk = await (await pc.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  await signup(desk, `pede-${run}@teste.com`, URL);
  await desk.goto(URL + "#/enviar");
  await desk.getByPlaceholder("cole um link").fill(LINK);
  await desk.getByRole("button", { name: "pedir", exact: true }).click();
  // Álbum/playlist pergunta se cria a playlist; vídeo único vai direto.
  const asPlaylist = desk.getByRole("button", { name: "pedir e criar a playlist" });
  await Promise.race([asPlaylist.click().catch(() => {}), desk.locator(".request").waitFor()]);
  await desk.locator(".request").waitFor();
  const t0 = Date.now();
  let last = "";
  let screenOff = false;
  while (Date.now() - t0 < 6 * 60_000) {
    const s = await status();
    if (s !== last) console.log("    celular:", s), (last = s);
    if (!(await desk.locator(".request").count())) break;
    const sub = await desk.locator(".request .track-sub").first().innerText().catch(() => "");
    if (/falh|não deu|não pôde/.test(sub)) console.log("    computador:", sub);
    if (!screenOff && /baixando|enviando|convertendo/.test(s)) screen("a02-app-ajudando"), (screenOff = true);
    await sleep(3000);
  }
  if (await desk.locator(".request").count()) {
    console.log("    pedido:", await desk.locator(".request").innerText());
    throw new Error("O pedido não terminou a tempo");
  }
  console.log(`    tudo pronto em ${Math.round((Date.now() - t0) / 1000)} s`);
  await desk.goto(URL + "#/biblioteca");
  await desk.getByRole("button", { name: "Playlists" }).click();
  console.log("    playlists de quem pediu:", (await desk.locator(".grid-item .track-title").allInnerTexts()).join(", "));
  // Quem baixou só ajudou: nada fica no celular dele (nem no cache, nem offline, nem na biblioteca).
  const kept = await phone.evaluate(
    () =>
      new Promise((ok, fail) => {
        const r = indexedDB.open("yfitops");
        r.onerror = () => fail(r.error);
        r.onsuccess = () => {
          const stores = ["cache", "files", "items"];
          const tx = r.result.transaction(stores);
          const out = {};
          for (const s of stores) tx.objectStore(s).count().onsuccess = (e) => (out[s] = e.target.result);
          tx.oncomplete = () => (r.result.close(), ok(out));
        };
      }),
  );
  console.log(`    guardado no celular que baixou: ${kept.cache} no cache, ${kept.files} offline, ${kept.items} na biblioteca`);
  if (kept.cache || kept.files || kept.items) throw new Error("O celular que baixou ficou com músicas que não pediu");

  step("tocando com a tela desligada: o app continua vivo");
  const service = () => (/KeepAliveService/.test(adb("shell", "dumpsys", "activity", "services", "dev.yfitops.app")) ? "rodando" : "parado");
  console.log("    serviço antes de tocar:", service());
  // Uma música do catálogo (a que o próprio celular baixou) entra na biblioteca dele e toca.
  await phone.goto(base + "#/buscar");
  await phone.locator('input[type="search"]').fill(process.env.QUEUE_SEARCH ?? "Singular");
  await phone.getByTitle("Adicionar e tocar").first().click({ timeout: 30000 });
  // O player usa "new Audio()" fora da página: quem diz se está tocando é o botão Pausar
  // e, com a tela desligada, o próprio Android (dumpsys audio).
  await phone.locator('button[title="Pausar"]').first().waitFor({ timeout: 30000 });
  await sleep(1500);
  console.log("    tocando; serviço:", service());
  adb("shell", "input", "keyevent", "KEYCODE_SLEEP");
  await sleep(8000);
  const playing = /state:started/.test(adb("shell", "dumpsys", "audio")) ? "sim" : "não";
  console.log("    tela desligada há 8 s; ainda tocando:", playing, "· serviço:", service(), "·", await status());
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  // Pausou: o serviço sai e o celular para de ajudar (se estiver fora da tela).
  // (Com som no emulador, a música de teste de 40 s pode ter acabado: aí já parou sozinha.)
  const pause = phone.locator('button[title="Pausar"]').first();
  if (await pause.isVisible()) await pause.click();
  else console.log("    a música de teste já tinha acabado");
  await sleep(2000);
  console.log("    parado; serviço:", service());
} catch (e) {
  failed = true;
  console.error("FALHOU:", e.message);
  try {
    screen("a00-falha");
  } catch {
    /* sem emulador */
  }
} finally {
  await pc.close();
  if (emulator && !process.env.KEEP_EMULATOR) {
    try {
      adb("emu", "kill");
    } catch {
      /* já desligou */
    }
  }
}
process.exit(failed ? 1 : 0);

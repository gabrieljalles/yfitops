import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Fila de importação por link, ponta a ponta, com dois navegadores:
//   - "computador": pede um álbum do Deezer (e cria a playlist);
//   - "celular": faz o papel do app Android (Chrome sem CORS + modo de teste),
//     lê o link, procura cada música no YouTube e envia ao catálogo.
// O áudio do "celular" é um WAV de teste (o YouTube costuma barrar o
// computador de quem testa muito); a busca no YouTube e o Deezer são de verdade.
//
//   APP_URL=http://127.0.0.1:8790/ node scripts/e2e-queue.mjs [pasta-das-capturas]
const OUT = process.argv[2] ?? "e2e-shots";
mkdirSync(OUT, { recursive: true });
const URL = process.env.APP_URL ?? "http://127.0.0.1:8787/";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
/** EP curto do Deezer (Anavitória, 4 faixas). */
const LINK = process.env.QUEUE_LINK ?? "https://www.deezer.com/album/213539402";

/** WAV 16-bit mono de 3 s (o "download" de teste). */
function wav(seconds = 3, rate = 22050) {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(0.3 * Math.sin((2 * Math.PI * 330 * i) / rate) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const step = (s) => console.log("→", s);
const logs = [];
const watch = (p, who) => {
  p.on("console", (m) => (m.type() === "error" || m.type() === "warning") && logs.push(`[${who} ${m.type()}] ${m.text()}`));
  p.on("pageerror", (e) => logs.push(`[${who} pageerror] ${e.message}`));
  p.on("response", async (r) => {
    if (r.status() >= 400 && r.url().includes("/api/")) logs.push(`[${who} ${r.status()}] ${r.request().method()} ${r.url().replace(URL, "/")} ${await r.text().catch(() => "")}`);
  });
};

async function signup(p, email) {
  await p.goto(URL);
  await p.getByRole("button", { name: "Criar conta" }).click();
  await p.getByLabel("E-mail").fill(email);
  await p.getByLabel("Senha", { exact: true }).fill("minha-senha-123");
  await p.getByLabel("Repita a senha").fill("minha-senha-123");
  const res = p.waitForResponse((r) => r.url().includes("/api/auth/signup/start"));
  await p.locator("form").getByRole("button", { name: "Continuar" }).click();
  const { devCode } = await (await res).json();
  await p.getByLabel("Código de 6 números").fill(devCode);
  await p.locator("form").getByRole("button", { name: "Criar conta" }).click();
  await p.getByText("Sua estante está vazia").waitFor({ timeout: 30000 });
}

const pc = await chromium.launch({ executablePath: CHROME });
const phoneBrowser = await chromium.launch({ executablePath: CHROME, args: ["--disable-web-security", "--disable-site-isolation-trials"] });
let failed = false;
try {
  const desk = await (await pc.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  watch(desk, "pc");
  const phoneCtx = await phoneBrowser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true });
  const audio = `data:audio/wav;base64,${wav().toString("base64")}`;
  await phoneCtx.addInitScript((a) => {
    localStorage.setItem("yfitops.spot-debug", "1");
    localStorage.setItem("yfitops.spot-test-audio", a);
  }, audio);
  const phone = await phoneCtx.newPage();
  watch(phone, "celular");

  const run = Date.now().toString(36);
  step("duas contas: quem pede (computador) e quem ajuda (celular)");
  await signup(desk, `pede-${run}@teste.com`);
  await signup(phone, `ajuda-${run}@teste.com`);
  // O celular sai da tela enquanto o computador pede (ainda não ajuda).
  await phone.goto(URL + "#/ajustes");
  await phone.getByText("Este celular ajuda a baixar").waitFor();

  step("computador pede o link");
  await desk.goto(URL + "#/enviar");
  await desk.getByText("conectado ao Wi-Fi").waitFor();
  await desk.screenshot({ path: join(OUT, "q01-enviar.png") });
  await desk.getByPlaceholder("ou cole um link").fill(LINK);
  await desk.getByRole("button", { name: "pedir", exact: true }).click();
  await desk.getByRole("button", { name: "pedir e criar a playlist" }).click();
  // Primeiro pedido: explica quem baixa e o Wi-Fi.
  await desk.getByText("precisa estar no Wi-Fi").waitFor();
  await desk.screenshot({ path: join(OUT, "q02-explica-wifi.png") });
  await desk.getByRole("button", { name: "entendi, pedir" }).click();
  await desk.locator(".request").waitFor();
  console.log("   ", await desk.locator(".request .track-sub").first().innerText());
  await desk.screenshot({ path: join(OUT, "q03-pedido.png") });

  step("celular ajuda: lê o link e baixa as músicas, uma por vez");
  const t0 = Date.now();
  const status = async () => (await phone.locator('[role="status"]').innerText().catch(() => "")).trim();
  let last = "";
  let shotDone = false;
  // O computador confere a cada 20 s; espera tudo chegar (o card some quando termina sem falhas).
  while (Date.now() - t0 < 8 * 60_000) {
    const s = await status();
    if (s !== last) console.log("    celular:", s), (last = s);
    if (!shotDone && /baixando|enviando|convertendo/.test(s)) {
      await phone.screenshot({ path: join(OUT, "q04-celular-ajudando.png") });
      shotDone = true;
    }
    const cards = await desk.locator(".request").count();
    if (cards) {
      const sub = await desk.locator(".request .track-sub").first().innerText().catch(() => "");
      if (sub !== desk._last) console.log("    computador:", sub), (desk._last = sub);
    }
    if (!cards && (await desk.evaluate(() => document.title !== undefined))) break;
    await desk.waitForTimeout(3000);
  }
  if (await desk.locator(".request").count()) throw new Error("O pedido não terminou a tempo");
  console.log(`    tudo pronto em ${Math.round((Date.now() - t0) / 1000)} s`);

  step("as músicas entraram SÓ na biblioteca de quem pediu, numa playlist");
  await desk.goto(URL + "#/biblioteca");
  await desk.getByRole("button", { name: "Playlists" }).click();
  await desk.locator(".grid-item").first().waitFor();
  const playlists = await desk.locator(".grid-item .track-title").allInnerTexts();
  console.log("    playlists:", playlists.join(", "));
  await desk.screenshot({ path: join(OUT, "q05-playlist.png") });
  await desk.locator(".grid-item").first().click();
  await desk.locator(".tracks li").first().waitFor();
  const n = await desk.locator(".tracks li").count();
  console.log("    músicas na playlist:", n);
  if (n < 2) throw new Error("A playlist veio vazia");
  await desk.screenshot({ path: join(OUT, "q06-musicas.png") });

  await phone.goto(URL + "#/biblioteca");
  await phone.getByText("Sua estante está vazia").or(phone.getByText(/Nenhuma música/)).first().waitFor({ timeout: 10000 });
  console.log("    biblioteca do celular continua vazia");

  step("sair do Wi-Fi / do app: o celular para de ajudar");
  await phone.goto(URL + "#/ajustes");
  console.log("    celular:", await status());
} catch (e) {
  failed = true;
  console.error("FALHOU:", e.message);
} finally {
  if (logs.length) console.log("\nconsole:\n" + logs.slice(0, 30).join("\n"));
  await pc.close();
  await phoneBrowser.close();
}
process.exit(failed ? 1 : 0);

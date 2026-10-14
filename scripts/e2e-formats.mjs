// Envia uma pasta de arquivos em vários formatos e confere o tratamento e a reprodução de cada um.
// Com o Worker local rodando (DEV_MODE=1):  npm run e2e:formats -- <pasta-com-arquivos>
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2];
if (!DIR) {
  console.error("Uso: npm run e2e:formats -- <pasta-com-arquivos>");
  process.exit(2);
}
const APP = process.env.APP_URL ?? "http://127.0.0.1:8787/";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const files = readdirSync(DIR).sort().map((f) => join(DIR, f));

const browser = await chromium.launch({ executablePath: CHROME, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => ["error", "warning"].includes(m.type()) && errors.push(`[${m.type()}] ${m.text()}`));
let failed = false;

try {
  console.log("→ criando conta");
  await page.goto(APP);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await page.getByLabel("E-mail").fill(`formatos-${Date.now()}@teste.com`);
  await page.getByLabel("Senha", { exact: true }).fill("senha-formatos");
  await page.getByLabel("Repita a senha").fill("senha-formatos");
  const res = page.waitForResponse((r) => r.url().includes("/api/auth/signup/start"));
  await page.locator("form").getByRole("button", { name: "Continuar" }).click();
  const { devCode } = await (await res).json();
  await page.getByLabel("Código de 6 números").fill(devCode);
  await page.locator("form").getByRole("button", { name: "Criar conta" }).click();
  await page.getByText("Sua estante está vazia").waitFor({ timeout: 30000 });

  console.log("→ enviando arquivos");
  await page.goto(APP + "#/enviar");
  await page.locator('input[type="file"][multiple]').setInputFiles(files);
  // Espera todos terminarem, mostrando o estado a cada 15 s (para ver onde trava).
  const deadline = Date.now() + 600000;
  let lastLog = 0;
  for (;;) {
    const subs = await page.locator(".job .track-sub").allInnerTexts();
    if (subs.length === files.length && subs.every((t) => /^(pronto|já existe|erro)/.test(t))) break;
    if (Date.now() > deadline) throw new Error("tempo esgotado esperando os envios");
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      const pending = subs.map((t, i) => [i, t]).filter(([, t]) => !/^(pronto|já existe|erro)/.test(t));
      console.log(`  … ${subs.length - pending.length}/${files.length} prontos; pendentes: ${pending.slice(0, 3).map(([i, t]) => `#${i} ${t}`).join(" | ")}`);
    }
    await page.waitForTimeout(1000);
  }
  console.log("Envio:");
  for (const job of await page.locator(".job").all()) {
    const name = await job.locator(".track-title").innerText();
    const sub = await job.locator(".track-sub").innerText();
    if (sub.startsWith("erro")) failed = true;
    console.log(`  ${sub.startsWith("pronto") ? "✓" : "✗"} ${name.padEnd(24)} ${sub}`);
  }
  await page.screenshot({ path: "e2e-shots/formatos-envio.png", fullPage: true });

  console.log("Reprodução:");
  await page.goto(APP + "#/biblioteca");
  await page.locator("select").selectOption("titulo");
  const rows = page.locator(".tracks li");
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const title = await rows.nth(i).locator(".track-title").innerText();
    await rows.nth(i).locator(".track-main").click();
    const ok = await page
      .locator('.player-bar button[title="Pausar"]')
      .waitFor({ timeout: 20000 })
      .then(() => true, () => false);
    const err = ok ? "" : (await page.locator(".player-bar").innerText()).replace(/\s+/g, " ");
    if (!ok) {
      failed = true;
      await page.screenshot({ path: `e2e-shots/formatos-falha-${i}.png` });
    }
    console.log(`  ${ok ? "✓" : "✗"} ${title.padEnd(24)} ${ok ? "tocando" : err}`);
  }
} catch (e) {
  failed = true;
  console.log("FALHOU:", e.message.split("\n")[0]);
  await page.screenshot({ path: "e2e-shots/formatos-erro.png" });
} finally {
  console.log(errors.length ? "Erros na página:\n" + errors.join("\n") : "Página: sem erros");
  await browser.close();
  process.exitCode = failed ? 1 : 0;
}

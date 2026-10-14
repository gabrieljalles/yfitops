import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Teste ponta a ponta no navegador. Com o Worker local rodando (npm run dev:server):
//   npm run e2e            (capturas em ./e2e-shots)
const OUT = process.argv[2] ?? "e2e-shots";
mkdirSync(OUT, { recursive: true });
const URL = process.env.APP_URL ?? "http://127.0.0.1:8787/";
// globalThis.URL: a constante URL acima (endereço do app) esconde o construtor.
const COVER = fileURLToPath(new globalThis.URL("../apps/web/public/icon-512.png", import.meta.url));
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

// WAV 24-bit estéreo 44.1 kHz, 6 s: acorde + um pouco de ruído.
function wav24(seconds = 6, rate = 44100) {
  const n = seconds * rate, ch = 2, bps = 3;
  const data = Buffer.alloc(n * ch * bps);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    for (let c = 0; c < ch; c++) {
      const s = 0.25 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * (330 + c * 2) * t) + 0.01 * (Math.random() - 0.5);
      data.writeIntLE(Math.round(s * 8388607), o, 3);
      o += 3;
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * ch * bps, 28); h.writeUInt16LE(ch * bps, 32); h.writeUInt16LE(24, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
// Responde o diálogo do próprio app (o que substituiu o prompt() do navegador).
const answerDialog = async (p, text) => {
  await p.locator(".dialog-input").fill(text);
  await p.locator(".dialog-actions .primary").click();
};
// Espera as animações de entrada terminarem antes da captura.
const shot = async (name) => (await page.waitForTimeout(700), page.screenshot({ path: join(OUT, `${name}.png`) }));
const step = (s) => console.log("→", s);

/** Etapa 2 do cadastro: em DEV_MODE o Worker devolve o código na resposta. */
async function enterSignupCode(p, shotName) {
  const res = p.waitForResponse((r) => r.url().includes("/api/auth/signup/start"));
  await p.locator("form").getByRole("button", { name: "Continuar" }).click();
  const { devCode } = await (await res).json();
  await p.getByText(/Enviamos um código|Modo de teste/).waitFor();
  if (shotName) {
    await p.waitForTimeout(700);
    await p.screenshot({ path: join(OUT, `${shotName}.png`) });
  }
  await p.getByLabel("Código de 6 números").fill(devCode);
  await p.locator("form").getByRole("button", { name: "Criar conta" }).click();
}

try {
  await page.goto(URL);
  step("criar conta");
  await page.getByRole("button", { name: "Criar conta" }).click();
  await page.locator("form").getByRole("button", { name: "Continuar" }).click();
  await page.getByText("Falta o e-mail").waitFor();
  await shot("01a-aviso-amarelo");
  const email = `eu-${Date.now()}@teste.com`;
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill("minha-senha-123");
  await page.getByLabel("Repita a senha").fill("outra-senha-123");
  await page.locator("form").getByRole("button", { name: "Continuar" }).click();
  await page.getByText("As senhas não são iguais").waitFor();
  await shot("01b-aviso-vermelho");
  await page.getByLabel("Repita a senha").fill("minha-senha-123");
  await enterSignupCode(page, "01c-aviso-verde-codigo");
  await page.getByText("Sua estante está vazia").waitFor({ timeout: 30000 });
  await shot("02-vazio");

  step("enviar WAV 24-bit");
  await page.goto(URL + "#/enviar");
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: "01 - Teste Acorde.wav", mimeType: "audio/wav", buffer: wav24() });
  await page.waitForTimeout(1500);
  await shot("03-enviando");
  await page.locator(".job .track-sub").filter({ hasText: /pronto|erro/ }).waitFor({ timeout: 240000 });
  const status = await page.locator(".job .track-sub").innerText();
  console.log("   status:", status);
  await shot("04-enviado");

  step("biblioteca e tocar");
  await page.goto(URL + "#/biblioteca");
  await page.getByText("Teste Acorde").first().waitFor();
  await page.locator(".track-main").first().click();
  await page.locator('.player-bar button[title="Pausar"]').waitFor({ timeout: 20000 });
  console.log("   tocando ✓");
  await shot("05-biblioteca-tocando");

  step("ficha: tag + grupo");
  await page.locator('.tracks button[title="Mais opções"]').first().click();
  await page.getByPlaceholder("adicionar tag…").fill("acustico");
  await page.getByPlaceholder("adicionar tag…").press("Enter");
  await page.locator(".chip.on", { hasText: "#acustico" }).waitFor();
  await page.getByRole("button", { name: "nova playlist" }).click();
  await answerDialog(page, "Estudo");
  await page.locator(".chip.on", { hasText: "Estudo" }).waitFor();
  await page.locator('.sheet input[type="file"]').setInputFiles(COVER);
  await page.locator(".sheet .cover img").waitFor({ timeout: 20000 });
  console.log("   capa ✓");
  await shot("06-ficha");
  await page.keyboard.press("Escape");

  step("buscar por tag e por texto");
  await page.goto(URL + "#/buscar");
  await page.getByPlaceholder(/Música, artista/).fill("acord");
  await page.locator(".tracks li").first().waitFor();
  await page.getByPlaceholder(/Música, artista/).fill("");
  await page.locator(".chip", { hasText: "#acustico" }).click();
  await page.locator(".tracks li").first().waitFor();
  console.log("   busca ✓");
  await shot("07-busca");

  step("início: recentes e grupos");
  await page.waitForTimeout(4000);
  await page.goto(URL + "#/");
  await page.getByText("Estudo").first().waitFor();
  await shot("08-inicio");

  step("player em tela cheia");
  await page.locator(".bar-info").click();
  await page.getByText("tocando agora").waitFor();
  // A faixa de teste tem 6 s: toca de novo para ver o vinil saindo da capa.
  const play = page.locator('.full-player button[title="Tocar"]');
  if (await play.count()) await play.click();
  await page.locator(".fp-cover.sleeve.out").waitFor({ timeout: 10000 });
  console.log("   vinil saindo da capa ✓");
  await shot("09-player");
  await page.locator('.full-player button[title="Minimizar"]').click();

  step("baixar grupo para offline");
  await page.goto(URL + "#/");
  await page.locator(".grid-item", { hasText: "Estudo" }).click();
  // Músicas do catálogo têm uma versão só (MP3): o menu não pergunta a qualidade.
  await page.getByRole("button", { name: /baixar/ }).click();
  await page.getByRole("menuitem", { name: /Baixar/ }).waitFor();
  await shot("10a-menu-baixar");
  await page.getByRole("menuitem", { name: /Baixar/ }).click();
  await page.getByRole("button", { name: /^\s*baixado$/ }).waitFor({ timeout: 30000 });
  console.log("   download offline ✓");
  await shot("10-grupo");

  step("celular");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(URL + "#/");
  await page.waitForTimeout(800);
  await shot("11-celular-inicio");
  await page.goto(URL + "#/ajustes");
  await page.waitForTimeout(800);
  await shot("12-celular-ajustes");

  step("sair e entrar de novo (outro aparelho)");
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p2 = await ctx2.newPage();
  await p2.goto(URL);
  await p2.getByLabel("E-mail").fill(email);
  await p2.getByLabel("Senha", { exact: true }).fill("minha-senha-123");
  await p2.locator("form").getByRole("button", { name: "Entrar" }).click();
  await p2.getByText("Estudo").first().waitFor({ timeout: 30000 });
  await p2.goto(URL + "#/biblioteca");
  await p2.getByText("Teste Acorde").first().waitFor();
  console.log("   sync entre aparelhos ✓");

  step("compartilhar grupo com outra pessoa");
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p3 = await ctx3.newPage();
  p3.on("pageerror", (e) => logs.push(`[pageerror B] ${e.message}`));
  const emailB = `amigo-${Date.now()}@teste.com`;
  await p3.goto(URL);
  await p3.getByRole("button", { name: "Criar conta" }).click();
  await p3.getByLabel("E-mail").fill(emailB);
  await p3.getByLabel("Senha", { exact: true }).fill("senha-do-amigo");
  await p3.getByLabel("Repita a senha").fill("senha-do-amigo");
  await enterSignupCode(p3);
  await p3.getByText("Sua estante está vazia").waitFor({ timeout: 30000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(URL + "#/");
  await page.locator(".grid-item", { hasText: "Estudo" }).click();
  await page.getByRole("button", { name: /compartilhar/ }).click();
  await answerDialog(page, emailB);
  await page.getByText(emailB).waitFor({ timeout: 20000 });
  await p3.reload();
  await p3.getByText("Compartilhados com você").waitFor({ timeout: 30000 });
  await p3.locator(".grid-item", { hasText: "Estudo" }).click();
  await p3.locator(".track-main").first().click();
  await p3.locator('.player-bar button[title="Pausar"]').waitFor({ timeout: 20000 });
  console.log("   amigo tocando a música compartilhada ✓");
  await p3.screenshot({ path: join(OUT, "13-compartilhado.png") });

  step("catálogo: o amigo acha a música na busca e adiciona sem enviar nada");
  await p3.goto(URL + "#/buscar");
  await p3.getByPlaceholder(/Música, artista/).fill("teste acorde");
  const fromCatalog = p3.locator(".catalog-results li", { hasText: "Teste Acorde" });
  await fromCatalog.waitFor({ timeout: 15000 });
  await p3.screenshot({ path: join(OUT, "14-busca-catalogo.png") });
  await fromCatalog.getByRole("button", { name: "Adicionar à biblioteca" }).click();
  await p3.getByText("Adicionada à biblioteca").waitFor();
  await p3.goto(URL + "#/biblioteca");
  await p3.getByText("Teste Acorde").first().waitFor();
  console.log("   música do catálogo na biblioteca do amigo ✓");
} catch (e) {
  console.log("FALHOU:", e.message.split("\n")[0]);
  process.exitCode = 1;
  await shot("erro");
} finally {
  console.log(logs.length ? "Console:\n" + logs.join("\n") : "Console: sem erros");
  await browser.close();
}

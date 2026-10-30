import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Indicações e cobrança, ponta a ponta:
//   - o administrador define a mensalidade e o valor por indicado e libera uma indicadora;
//   - quem chega pelo link dela espera a aprovação, e o painel mostra quem indicou;
//   - o pagamento do indicado guarda o valor por 30 dias; depois o administrador paga;
//   - estorno derruba a comissão; mensalidade por pessoa muda o valor cobrado.
//
// Precisa de um servidor só para o teste (o administrador é admin@exemplo.com, conta nova):
//   npx wrangler d1 migrations apply yfitops --local --persist-to <pasta>   (em server/)
//   npx wrangler dev --port 8790 --persist-to <pasta>                       (em server/)
//   PERSIST=<pasta> APP_URL=http://127.0.0.1:8790/ node scripts/e2e-referral.mjs [pasta-das-capturas]
const OUT = process.argv[2] ?? "e2e-shots";
mkdirSync(OUT, { recursive: true });
const URL = process.env.APP_URL ?? "http://127.0.0.1:8790/";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PERSIST = process.env.PERSIST;
if (!PERSIST) throw new Error("Falta PERSIST (a pasta do banco local do servidor de teste)");
const stamp = Date.now();

const step = (s) => console.log("→", s);
const ok = (s) => console.log(`   ${s} ✓`);
const logs = [];
const watch = (p, who) => {
  p.on("console", (m) => m.type() === "error" && logs.push(`[${who}] ${m.text()}`));
  p.on("pageerror", (e) => logs.push(`[${who} pageerror] ${e.message}`));
};

/** Pula os 30 dias de espera (direto no banco local do teste). */
function skipHold() {
  execSync(`npx wrangler d1 execute yfitops --local --persist-to "${PERSIST}" --command "UPDATE referral_rewards SET available_at = 0"`, {
    cwd: "server",
    stdio: "ignore",
  });
}

async function signup(p, email, { invite, pending } = {}) {
  await p.goto(invite ?? URL);
  if (!invite) await p.getByRole("button", { name: "Criar conta" }).click();
  await p.getByLabel("E-mail").fill(email);
  await p.getByLabel("Senha", { exact: true }).fill("minha-senha-123");
  await p.getByLabel("Celular (WhatsApp)").fill("11987654321");
  await p.getByLabel("Repita a senha").fill("minha-senha-123");
  const res = p.waitForResponse((r) => r.url().includes("/api/auth/signup/start"));
  await p.locator("form").getByRole("button", { name: "Continuar" }).click();
  const { devCode } = await (await res).json();
  await p.getByLabel("Código de 6 números").fill(devCode);
  await p.locator("form").getByRole("button", { name: "Criar conta" }).click();
  await p.getByText(pending ? "Pode fechar e voltar depois" : "Sua estante está vazia").waitFor({ timeout: 30000 });
}

const browser = await chromium.launch({ executablePath: CHROME });
const context = async (opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("yfitops.install-app-dismissed", String(Date.now()));
    } catch {}
  });
  return ctx;
};
let failed = false;
try {
  const admin = await (await context()).newPage();
  watch(admin, "admin");
  const shot = (p, name) => p.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  const person = (email) => admin.locator(".admin-list li", { hasText: email });
  const openAdmin = async (tab) => {
    await admin.goto(URL + "#/admin");
    await admin.reload(); // mesmo endereço: recarrega para ver o que mudou
    await admin.getByRole("tab", { name: tab }).click();
  };

  step("administrador define os valores");
  await signup(admin, "admin@exemplo.com");
  await openAdmin("Dinheiro");
  await admin.getByLabel("Mensalidade padrão").fill("25,00");
  await admin.getByLabel("Valor por indicado").fill("10");
  await admin.getByRole("button", { name: "salvar" }).click();
  await admin.getByText("Valores salvos").waitFor();
  ok("mensalidade R$ 25,00 e R$ 10,00 por indicado");

  step("libera uma indicadora");
  const ana = await (await context()).newPage();
  watch(ana, "ana");
  const anaEmail = `ana-${stamp}@teste.com`;
  await signup(ana, anaEmail);
  await openAdmin("Pessoas");
  await person(anaEmail).getByLabel("pode indicar").check();
  await admin.getByText(`${anaEmail} agora pode indicar`).waitFor();
  await ana.goto(URL + "#/ajustes");
  await ana.reload(); // a sessão fica sabendo que ela pode indicar
  await ana.getByRole("heading", { name: "Indicações" }).waitFor({ timeout: 30000 });
  const link = (await ana.locator(".invite-link code").textContent()).trim();
  if (!/#\/convite\/[A-Z0-9]{6}$/.test(link)) throw new Error(`link de convite estranho: ${link}`);
  ok(`link ${link.replace(URL, "/")}`);

  step("indicado chega pelo link e espera aprovação");
  const bia = await (await context()).newPage();
  watch(bia, "bia");
  const biaEmail = `bia-${stamp}@teste.com`;
  await signup(bia, biaEmail, { invite: link, pending: true });
  ok("mesmo com e-mail liberado, espera aprovação");
  await ana.reload();
  await ana.getByText("esperando aprovação").waitFor();
  ok("indicadora vê: esperando aprovação");

  step("painel mostra quem indicou e aprova");
  await openAdmin("Pessoas");
  await person(biaEmail).getByText(`indicado por ${anaEmail}`).waitFor();
  await shot(admin, "r1-pedido-indicado");
  await person(biaEmail).getByRole("button", { name: "aceitar" }).click();
  await admin.getByText(`${biaEmail} pode entrar`).waitFor();
  const amount = person(biaEmail).getByLabel("Valor recebido");
  if ((await amount.inputValue()) !== "25,00") throw new Error(`valor sugerido: ${await amount.inputValue()}`);
  ok("valor do pagamento já vem com a mensalidade (25,00)");
  await person(biaEmail).getByRole("button", { name: "registrar pagamento" }).click();
  await admin.getByText(`R$ 25,00 registrado: 1 mês para ${biaEmail}`).waitFor();
  await ana.reload();
  await ana.getByText(/pagou · R\$\s10,00 liberado em/).waitFor();
  ok("indicadora vê o valor guardado por 30 dias");

  step("depois dos 30 dias, o administrador paga");
  skipHold();
  await openAdmin("Dinheiro");
  const anaRow = person(anaEmail);
  await anaRow.getByText(/a pagar R\$\s10,00/).waitFor();
  await shot(admin, "r2-dinheiro");
  await anaRow.getByRole("button", { name: "marcar como pago" }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "marcar como pago" }).click();
  await admin.getByText("Marcado como pago").waitFor();
  await ana.reload();
  await ana.getByText(/R\$\s10,00 recebido/).waitFor();
  await ana.getByText(/Mensalidade: R\$\s25,00/).waitFor(); // aviso de vencimento (período de teste)
  await shot(ana, "r3-ajustes-indicadora");
  ok("pago e visto pela indicadora");

  step("estorno derruba a comissão");
  const cai = await (await context()).newPage();
  const caiEmail = `cai-${stamp}@teste.com`;
  await signup(cai, caiEmail, { invite: link, pending: true });
  await openAdmin("Pessoas");
  await person(caiEmail).getByRole("button", { name: "aceitar" }).click();
  await admin.getByText(`${caiEmail} pode entrar`).waitFor();
  await person(caiEmail).getByRole("button", { name: "registrar pagamento" }).click();
  await admin.getByText(`registrado: 1 mês para ${caiEmail}`).waitFor();
  await admin.getByRole("tab", { name: "Dinheiro" }).click();
  await admin.locator(".payments li", { hasText: caiEmail }).getByRole("button", { name: "estornar" }).click();
  await admin.getByRole("alertdialog").getByRole("button", { name: "estornar" }).click();
  await admin.getByText("Pagamento estornado", { exact: true }).waitFor();
  await ana.reload();
  await ana.getByText("não contou (pagamento cancelado)").waitFor();
  ok("estornado: a indicadora não ganha");

  step("mensalidade combinada por pessoa");
  await admin.getByRole("tab", { name: "Pessoas" }).click();
  await person(caiEmail).getByRole("button", { name: "mudar" }).click();
  await admin.getByRole("dialog").locator("input").fill("15,90");
  await admin.getByRole("dialog").getByRole("button", { name: "salvar" }).click();
  await admin.getByText("Mensalidade salva").waitFor();
  await person(caiEmail).getByText("R$ 15,90").waitFor();
  if ((await person(caiEmail).getByLabel("Valor recebido").inputValue()) !== "15,90") throw new Error("valor não seguiu a mensalidade da pessoa");
  ok("R$ 15,90 só para essa pessoa");
  await admin.getByRole("radio", { name: "indicadoras" }).click();
  if ((await admin.locator(".admin-list li", { hasText: "@teste.com" }).count()) !== 1) throw new Error("filtro de indicadoras");
  ok("filtro de indicadoras");
  await shot(admin, "r4-pessoas");

  step("celular");
  const phone = await (await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  watch(phone, "celular");
  await phone.goto(URL);
  await phone.getByLabel("E-mail").fill("admin@exemplo.com");
  await phone.getByLabel("Senha", { exact: true }).fill("minha-senha-123");
  await phone.locator("form").getByRole("button", { name: "Entrar" }).click();
  await phone.getByText("Sua estante está vazia").waitFor({ timeout: 30000 });
  await phone.goto(URL + "#/admin");
  await phone.getByRole("tab", { name: "Dinheiro" }).click();
  await phone.getByText("Recebido neste mês").waitFor();
  await shot(phone, "r5-celular-dinheiro");
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) throw new Error(`painel passa da largura do celular (${overflow}px)`);
  ok("sem rolagem para o lado");
} catch (e) {
  failed = true;
  console.error("FALHOU:", e.message);
} finally {
  await browser.close();
}
console.log(logs.length ? `Console:\n${logs.join("\n")}` : "Console: sem erros");
process.exit(failed ? 1 : 0);

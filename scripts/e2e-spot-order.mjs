import { chromium } from "playwright-core";

// Ordem da fila de downloads, direto na API (sem baixar nada de verdade):
//   - o celular de quem pediu pega a 1ª música dele; os outros livres já pegam as seguintes;
//   - sem trabalho, o servidor segura o pedido de trabalho e responde assim que chega um pedido.
//
// Precisa de um servidor com o banco vazio (a fila não pode ter pedidos de outros testes):
//   npx wrangler d1 migrations apply yfitops --local --persist-to <pasta>   (em server/)
//   npx wrangler dev --port 8790 --persist-to <pasta>                       (em server/)
//   APP_URL=http://127.0.0.1:8790/ node scripts/e2e-spot-order.mjs
const URL = process.env.APP_URL ?? "http://127.0.0.1:8790/";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const run = Date.now();

/** Sessão de cada página (o app manda "Authorization: Bearer ..."). */
const tokens = new Map();

async function signup(p, email) {
  p.on("request", (r) => {
    const auth = r.headers().authorization;
    if (auth) tokens.set(p, auth);
  });
  await p.goto(URL);
  await p.getByRole("button", { name: "Criar conta" }).click();
  await p.getByLabel("E-mail").fill(email);
  await p.getByLabel("Senha", { exact: true }).fill("minha-senha-123");
  await p.getByLabel("Celular (WhatsApp)").fill("11987654321");
  await p.getByLabel("Repita a senha").fill("minha-senha-123");
  const res = p.waitForResponse((r) => r.url().includes("/api/auth/signup/start"));
  await p.locator("form").getByRole("button", { name: "Continuar" }).click();
  const { devCode } = await (await res).json();
  await p.getByLabel("Código de 6 números").fill(devCode);
  await p.locator("form").getByRole("button", { name: "Criar conta" }).click();
  await p.getByText("Sua estante está vazia").waitFor({ timeout: 30000 });
}

/** Chama a API com a sessão da página. */
const call = (p, path, json) =>
  p.evaluate(
    async ([path, json, auth]) => {
      const r = await fetch(`/api${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(json) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, json, tokens.get(p)],
  );
const claim = (p, device) => call(p, "/spot/claim", { device, mineOnly: false, helper: false });
const expect = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`   ${what} ✓`);
};

const browser = await chromium.launch({ executablePath: CHROME });
let failed = false;
try {
  const ana = await (await browser.newContext()).newPage();
  const bia = await (await browser.newContext()).newPage();
  await signup(ana, `ordem-ana-${run}@teste.com`);
  await signup(bia, `ordem-bia-${run}@teste.com`);
  const anaPhone = `ana-phone-${run}`;
  const biaPhone = `bia-phone-${run}`;
  const biaTablet = `bia-tablet-${run}`;

  console.log("→ fila vazia: o servidor segura a resposta e acorda com o pedido");
  const started = Date.now();
  const held = claim(bia, biaPhone);
  await bia.waitForTimeout(3000);
  await call(ana, "/imports", { url: "https://www.deezer.com/album/213539402", opts: { tags: [], playlist: false } });
  const list = await held;
  if (list.body?.job?.type !== "list") console.log("   resposta:", JSON.stringify(list));
  const took = Date.now() - started;
  expect(list.body?.job?.type === "list", `a leitura do link chegou segurando a conexão (${(took / 1000).toFixed(1)} s)`);
  expect(took < 7000, "em poucos segundos depois do pedido");

  // Ana já avisou que está livre (o celular dela pede trabalho); a leitura vira 3 músicas.
  const anaIdle = claim(ana, anaPhone);
  await call(bia, `/spot/list/${list.body.job.id}`, {
    device: biaPhone,
    provider: "deezer",
    tracks: [1, 2, 3].map((n) => ({ meta: { videoId: `vid${n}xxxxxx`, title: `Faixa ${n}`, artist: "Teste", duration: 200 } })),
  });
  const first = await anaIdle;
  expect(first.body?.job?.meta?.title === "Faixa 1" && first.body.job.mine, "o celular de quem pediu pega a 1ª música");

  console.log("→ os outros celulares já adiantam as seguintes");
  const second = await claim(bia, biaPhone);
  const third = await claim(bia, biaTablet);
  expect(second.body?.job?.meta?.title === "Faixa 2", "outro celular pega a 2ª em paralelo");
  expect(third.body?.job?.meta?.title === "Faixa 3", "mais um celular pega a 3ª");

  console.log("→ o celular de quem pediu saiu no meio: a música dele volta e outro pega na hora");
  await call(ana, "/spot/leave", { device: anaPhone });
  const taken = await claim(bia, `bia-tv-${run}`);
  expect(taken.body?.job?.meta?.title === "Faixa 1", "sem o celular dela livre, outro celular baixa a 1ª");
} catch (e) {
  failed = true;
  console.error("FALHOU:", e.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

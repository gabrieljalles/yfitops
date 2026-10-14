# yfitops

Player de música pessoal na nuvem: suas músicas criptografadas na Cloudflare (R2 + D1 + Workers), tocando em qualquer lugar.

- **Qualquer formato, sem perda de qualidade:**
  - comuns e leves (MP3, AAC/M4A, OGG, Opus) ficam **exatamente como estão**;
  - sem perda e pesados (WAV, AIFF, ALAC, APE, WavPack, TTA, FLAC) viram **FLAC**. Antes de aceitar, o app confere bit a bit que o áudio é idêntico ao original; se não for, guarda o original;
  - DSD (DSF/DFF) vira FLAC 24-bit/176,4 kHz (conversão padrão DSD→PCM; não é bit a bit por natureza);
  - com perda incomuns (WMA, AC3, DTS, MP2…): o original fica intacto, mais uma versão tocável;
  - vídeos (MP4, MKV, WEBM, MOV…): o áudio é extraído **sem reconverter** e o vídeo é descartado.
- **Versão leve** Opus 160 kbps (WebCodecs) para os dados móveis. O download offline deixa escolher **normal** (Opus) ou **máxima** (FLAC).
- **Criptografia no aparelho.** O R2 e o D1 só guardam dados ilegíveis. IDs de arquivo são HMAC do conteúdo (um "magnet" privado, que deduplica sem revelar nada), e a chave de cada arquivo também é derivada do conteúdo dentro da sua conta: arquivos repetidos (a mesma capa num álbum, a mesma música em dois formatos) geram exatamente o mesmo cifrado.
- **Capas:** qualquer imagem é recortada num quadrado pelo centro (cortando o lado maior), recebe por cima a textura de capa de disco gasta (`apps/web/public/textura_vinil_branca.png`) e vira um WebP de 300×300 com cerca de 8–30 KB. Sem capa, aparece um vinil desenhado, sem custo de armazenamento.
- Tags, busca, tocadas recentemente, grupos, offline, várias contas e compartilhamento de grupos.

## Estrutura

```
packages/core   criptografia, formato de blocos, decisão de compressão, tipos (compartilhado)
server          Cloudflare Worker (Hono) + D1 + R2; também serve o app web
apps/web        app React (PWA): instalável no Android e no Windows pelo navegador
scripts         teste ponta a ponta no navegador
```

## Rodar localmente

```bash
npm install
cd server
node scripts/gen-escrow.mjs > .dev.vars      # chaves de recuperação (dev)
echo DEV_MODE=1 >> .dev.vars                 # devolve o código de cadastro na resposta (testes)
npx wrangler d1 migrations apply yfitops --local
cd ..
npm run build            # gera apps/web/dist, servido pelo Worker
npm run dev:server       # http://127.0.0.1:8787
```

Para desenvolver a interface com recarga automática, rode também `npm run dev:web` (http://localhost:5173, que faz proxy de `/api` para o Worker).

Sem `RESEND_API_KEY`, os e-mails (código de cadastro e link de "esqueci a senha") aparecem só no log do Worker.

### Testes

```bash
npm test                                                     # unidade (criptografia, blocos, decisões)
cd packages/core && API_URL=http://127.0.0.1:8787 npx vitest run   # API real (Worker com DEV_MODE=1)
npm run e2e                                                  # navegador: avisos, cadastro em 2 etapas, envio, FLAC verificado, tocar, capa, tags, grupos, offline normal/máxima, sync, compartilhamento
npm run e2e:formats -- <pasta>                               # envia todos os arquivos da pasta e confere tratamento e reprodução de cada formato
```

## Publicar na Cloudflare (plano gratuito)

1. Entrar: `cd server && npx wrangler login`
2. Ativar o R2 no painel (R2 Object Storage → Purchase/Enable). Pode pedir um cartão, mas até 10 GB é grátis e o download nunca é cobrado.
3. Criar recursos:
   ```bash
   npx wrangler d1 create yfitops          # copie o database_id para wrangler.toml
   npx wrangler r2 bucket create yfitops-music
   npx wrangler d1 migrations apply yfitops --remote
   ```
4. Segredos:
   ```bash
   node scripts/gen-escrow.mjs             # gera ESCROW_PRIVATE_KEY e ESCROW_PUBLIC_KEY
   npx wrangler secret put ESCROW_PRIVATE_KEY
   npx wrangler secret put ESCROW_PUBLIC_KEY
   npx wrangler secret put ALLOWED_EMAILS  # convidados: "eu@x.com, mae@y.com" ou "@familia.com"
   npx wrangler secret put RESEND_API_KEY  # envio dos e-mails (resend.com, plano grátis)
   ```
   **Guarde as chaves de escrow num gerenciador de senhas.** Sem elas, ninguém consegue recuperar a conta por e-mail.

   O cadastro tem duas etapas: e-mail e senha, depois um código de 6 dígitos enviado por e-mail. Só quem está em `ALLOWED_EMAILS` recebe código. **Não use `DEV_MODE` em produção.**

   No Resend, o remetente de teste (`onboarding@resend.dev`) só entrega para o e-mail da sua própria conta Resend. Para mandar para a família, verifique um domínio seu no Resend e ajuste `MAIL_FROM` no `wrangler.toml`.
5. Publicar: `cd .. && npm run deploy`. O app fica em `https://yfitops.<sua-conta>.workers.dev`.

No celular Android (Chrome) ou no Windows (Edge/Chrome), abra o endereço e use **Instalar app**. A música continua tocando com a tela bloqueada e tem controles na notificação.

## Segurança: o que saber

- Músicas, capas, títulos, tags, grupos e histórico são criptografados no aparelho (AES-256-GCM).
- A senha nunca sai do aparelho. O Argon2id deriva dela a chave de login e a chave que abre a chave mestra.
- **Recuperação por e-mail:** uma cópia da chave mestra fica cifrada para a chave de escrow do Worker. Isso torna a recuperação simples, mas quem controla o Worker (o admin) tecnicamente consegue decifrar. Um vazamento só do R2/D1 não expõe nada.
- Compartilhar um grupo envia um instantâneo cifrado para a chave pública da pessoa. Use **atualizar** no grupo para mandar a versão nova.

## Próximos passos

- App de computador (Tauri) com FFmpeg nativo, para converter lotes grandes bem mais rápido.
- App Android nativo (Capacitor), se o PWA não bastar.
- Streaming progressivo por blocos (o formato já permite; hoje a faixa é baixada inteira antes de tocar).

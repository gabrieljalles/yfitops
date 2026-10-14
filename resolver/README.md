# resolver

Servidor mínimo que traduz um **link de playlist do YouTube ou do Spotify** em
**arquivos de áudio** para o yfitops importar.

Ele **não guarda música nenhuma** e não fala com a sua conta. Só faz duas coisas:

1. recebe o link da playlist e devolve a **lista de faixas**;
2. para cada faixa, devolve a **URL do áudio**.

Quem baixa, converte, criptografa e sobe é o app — pelo mesmo caminho de quando você
arrasta arquivos.

## Como o Spotify funciona aqui

O Spotify **não** entrega o arquivo de áudio: o streaming é protegido por DRM e não é
acessível. Então, para uma playlist do Spotify, o resolver:

1. lê a lista de faixas pela **API oficial** do Spotify (só os metadados: nome, artista,
   álbum, capa) — isso é legítimo e gratuito;
2. procura cada música no **YouTube** por texto (`"artista - música álbum"`) e baixa o
   áudio de lá.

É exatamente o que ferramentas como o **spotdl** fazem. A qualidade final é a do YouTube,
não a do Spotify.

## Por que existe um servidor separado

O navegador não consegue falar com o YouTube diretamente (CORS, exigência de `Referer`
e de um cliente nativo). Este servidor roda **fora do navegador**, então pode usar o
`yt-dlp`, que faz esse trabalho. O app só consome o resultado. Ele também guarda o
`Client Secret` do Spotify, que não pode ficar no navegador.

## Requisitos

- **Node.js 18+**
- **yt-dlp** instalado e no `PATH` (ou aponte `YTDLP_PATH` para o executável).
- **Credenciais do Spotify** (opcionais — só se você quiser importar playlists do
  Spotify; links do YouTube funcionam sem elas). Veja abaixo.

Instalar o yt-dlp:

```bash
# Windows (via pip)
py -m pip install -U yt-dlp

# Windows (via winget)
winget install yt-dlp.yt-dlp

# macOS
brew install yt-dlp

# Linux
python3 -m pip install -U yt-dlp
# ou baixe o binário em https://github.com/yt-dlp/yt-dlp/releases
```

> **Mantenha o yt-dlp atualizado.** O YouTube muda com frequência; quando algo parar de
> funcionar, quase sempre é só rodar `yt-dlp -U` (ou reinstalar) que volta.

## Rodar

```bash
cd resolver
npm start            # http://127.0.0.1:8788
```

Variáveis opcionais:

- `PORT` — porta (padrão `8788`).
- `YTDLP_PATH` — caminho do binário, se não estiver no `PATH`.
- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` — para importar links do Spotify (veja
  abaixo).
- `RESOLVER_TOKEN` — senha do resolver. Com ela, só o app com a mesma senha (Ajustes →
  **Importar por link**) consegue usar o servidor. **Obrigatória antes de expor o resolver
  na internet** (ex.: Cloudflare Tunnel); sem ela, qualquer um baixaria do YouTube pelo seu IP.
  Gere uma com `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
- `ALLOWED_ORIGINS` — sites que podem chamar o resolver, separados por vírgula (ex.:
  `https://yfitops.suaconta.workers.dev,http://localhost:5173`). Vazio = qualquer site.

### Credenciais do Spotify (para playlists do Spotify)

Só precisa disso se você for importar links do Spotify. É **grátis** e leva ~2 minutos:

1. Acesse <https://developer.spotify.com/dashboard> e faça login.
2. Clique em **Create app**. Dê um nome qualquer (ex.: "yfitops"), e em _Redirect URI_
   ponha qualquer coisa (ex.: `http://127.0.0.1:8788`) — não usamos redirect.
3. Abra o app criado e copie o **Client ID** e o **Client Secret**.
4. Passe para o resolver por variáveis de ambiente:

```powershell
$env:SPOTIFY_CLIENT_ID = "seu_client_id"
$env:SPOTIFY_CLIENT_SECRET = "seu_client_secret"
npm start
```

```bash
# macOS / Linux
SPOTIFY_CLIENT_ID=seu_client_id SPOTIFY_CLIENT_SECRET=seu_client_secret npm start
```

> Usa-se apenas o fluxo **Client Credentials** (sem login de usuário, sem redirect).
> O Client Secret fica **só** no servidor; nunca vai para o navegador. Playlists
> **privadas** do Spotify não são acessíveis por esse fluxo (precisariam do login da
> própria conta) — use playlists públicas ou "descobertas".

## Evitando bloqueios do YouTube

O que já é feito automaticamente:

- **Um pedido por música** ao yt-dlp (link do áudio e tags juntos).
- **Pausa de 2 s entre músicas**; pedidos em rajada são o que mais leva a bloqueio.
- **Novas tentativas** em falhas passageiras (3 s, depois 10 s), sempre com um link novo.
- **Limite do YouTube** (429 / "confirm you're not a bot"): espera 45 s e tenta uma vez;
  se acontecer de novo, **para** a importação em vez de insistir. As restantes aparecem
  como "não tentadas" e dá para tentar de novo depois.
- Vídeo removido, privado ou bloqueado: não tenta de novo (não adianta).

Se o YouTube pedir verificação anti-robô com frequência, use **cookies de uma conta
logada** (de preferência uma conta secundária, não a principal):

```powershell
$env:YTDLP_COOKIES_FROM_BROWSER = "firefox"   # ou: $env:YTDLP_COOKIES = "C:\caminho\cookies.txt"
npm start
```

No Windows, ler cookies do Chrome/Edge costuma falhar (eles criptografam os cookies);
o Firefox funciona. E mantenha o yt-dlp atualizado: `winget upgrade yt-dlp.yt-dlp`.

## O que o app precisa saber

No app (apps/web), defina a URL do resolver. Ex.: crie `.env.local` em `apps/web`:

```
VITE_RESOLVER_URL=http://127.0.0.1:8788
```

Se não definir, o app usa `http://127.0.0.1:8788` por padrão.

Cada aparelho também pode trocar o endereço e informar a senha em **Ajustes → Importar por
link** (fica salvo só naquele aparelho, nunca no código publicado). O botão **salvar e
testar** diz se o resolver respondeu e se a senha está certa.

O app publicado (https) consegue falar com o resolver em `127.0.0.1` no mesmo computador: o
resolver responde ao pedido de licença do Chrome para rede local
(`Access-Control-Allow-Private-Network`).

## Endpoints

### `GET /health`

```json
{ "ok": true }
```

### `POST /resolve`

Corpo: `{ "url": "<link da playlist ou de um vídeo>" }`

**YouTube** — aceita link de playlist (`list=`) ou de um vídeo solto (`watch?v=`,
`youtu.be/…`, `/shorts/…`); no vídeo solto, `playlist` vem `null` e `tracks` tem um item
só. Se o link tiver vídeo **e** playlist, vale a playlist.

**Rádios/mixes** (`list=RD…`, ex.: `watch?v=…&list=RD…`) também funcionam. Como um
mix é quase infinito (500+ vídeos), só os **50 primeiros** são lidos; mude com
`YT_MIX_LIMIT` (ex.: `$env:YT_MIX_LIMIT = "100"`).

Resposta:

```json
{
  "playlist": "PL....",
  "tracks": [
    {
      "videoId": "abc123",
      "title": "Faixa 1",
      "artist": "Canal",
      "duration": 213
    }
  ]
}
```

**Spotify** — aceita `open.spotify.com/playlist/<id>`, `/album/<id>`, `/track/<id>` e links
curtos `spotify.link/<id>`. Requer as credenciais do Spotify. As faixas vêm **sem
`videoId`**, com um campo `query` (o texto a buscar no YouTube) e a capa:

```json
{
  "provider": "spotify",
  "playlist": "37i9dQ...",
  "tracks": [
    {
      "videoId": "",
      "spotifyId": "4cOdK...",
      "title": "Faixa 1",
      "artist": "Artista, Outro Artista",
      "album": "Álbum",
      "duration": 213,
      "cover": "https://i.scdn.co/image/....jpg",
      "query": "Artista, Outro Artista Faixa 1 Álbum"
    }
  ]
}
```

### `POST /resolve/track`

Corpo: `{ "videoId": "abc123" }`

Resposta:

```json
{
  "videoId": "abc123",
  "streamUrl": "https://....googlevideo.com/...",
  "title": "Faixa 1",
  "artist": "Canal"
}
```

### `POST /resolve/search`

Corpo: `{ "query": "Artista - música" }`

Procura a melhor correspondência no YouTube e devolve os metadados dela. É assim que o
app descobre o `videoId` de cada faixa do Spotify antes de baixar.

```json
{
  "videoId": "abc123",
  "title": "Faixa 1 (Official Audio)",
  "artist": "Canal",
  "duration": 214
}
```

### `GET /stream?u=<streamUrl>`

Repassa o áudio do `streamUrl` para o navegador, com CORS liberado (o googlevideo não
libera). Baixa em pedaços de 10 MB, porque um pedido único inteiro o YouTube limita à
velocidade de reprodução. Só aceita URLs do `googlevideo.com`.

## Como o app usa isso

1. Você cola o link na tela de envio (YouTube **ou** Spotify).
2. O app chama `POST /resolve` e mostra a lista.
3. Para cada faixa:
   - **YouTube:** já tem `videoId`; chama `POST /resolve/track`.
   - **Spotify:** ainda não tem; chama `POST /resolve/search` com o `query` para achar o
     vídeo no YouTube, e então segue igual.
4. Baixa o áudio por `GET /stream`, transforma em `File` e entrega ao **mesmo importador**
   dos arquivos locais (`enqueue`).
5. Daí pra frente é o pipeline normal: dedupe por conteúdo, conversão, criptografia e upload.

## Segurança e limites

- **Só aceita links do YouTube e do Spotify**. Não é um proxy aberto.
- O `Client Secret` do Spotify fica **apenas** neste servidor (nunca no navegador).
- O `streamUrl` é **temporário** (expira). Ele é usado logo após ser obtido; não guarde.
- Rode em `127.0.0.1` (padrão) ou atrás de autenticação sua se for expor na rede.

## Nota legal

A qualidade do áudio importado do Spotify é a do **YouTube** (é de lá que o áudio vem),
não a do Spotify. Baixe apenas conteúdo que você tem o direito de baixar. A
responsabilidade pelo uso é de quem opera o servidor e o app.

# resolver

Servidor mínimo que traduz um **link de playlist do YouTube** em **arquivos de áudio**
para o yfitops importar.

Ele **não guarda música nenhuma** e não fala com a sua conta. Só faz duas coisas:

1. recebe o link da playlist e devolve a **lista de faixas**;
2. para cada faixa, devolve a **URL do áudio**.

Quem baixa, converte, criptografa e sobe é o app — pelo mesmo caminho de quando você
arrasta arquivos.

## Por que existe um servidor separado

O navegador não consegue falar com o YouTube diretamente (CORS, exigência de `Referer`
e de um cliente nativo). Este servidor roda **fora do navegador**, então pode usar o
`yt-dlp`, que faz esse trabalho. O app só consome o resultado.

## Requisitos

- **Node.js 18+**
- **yt-dlp** instalado e no `PATH` (ou aponte `YTDLP_PATH` para o executável).

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
npm install
npm start            # http://127.0.0.1:8788
```

Variáveis opcionais:

- `PORT` — porta (padrão `8788`).
- `YTDLP_PATH` — caminho do binário, se não estiver no `PATH`.

## O que o app precisa saber

No app (apps/web), defina a URL do resolver. Ex.: crie `.env.local` em `apps/web`:

```
VITE_RESOLVER_URL=http://127.0.0.1:8788
```

Se não definir, o app usa `http://127.0.0.1:8788` por padrão.

## Endpoints

### `GET /health`

```json
{ "ok": true }
```

### `POST /resolve`

Corpo: `{ "url": "<link da playlist>" }`

Resposta:

```json
{
  "playlist": "PL....",
  "tracks": [
    { "videoId": "abc123", "title": "Faixa 1", "artist": "Canal", "duration": 213 },
    { "videoId": "def456", "title": "Faixa 2", "artist": "Canal", "duration": 187 }
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

## Como o app usa isso

1. Você cola o link na tela de envio.
2. O app chama `POST /resolve` e mostra a lista.
3. Para cada faixa, chama `POST /resolve/track`, baixa o áudio, transforma em `File`
   e entrega ao **mesmo importador** dos arquivos locais (`enqueue`).
4. Daí pra frente é o pipeline normal: dedupe por conteúdo, conversão, criptografia e upload.

## Segurança e limites

- **Só aceita links do YouTube** (youtube.com, youtu.be, music.youtube.com). Não é um
  proxy aberto.
- O `streamUrl` é **temporário** (expira). Ele é usado logo após ser obtido; não guarde.
- Rode em `127.0.0.1` (padrão) ou atrás de autenticação sua se for expor na rede.

## Nota legal

Baixe apenas conteúdo que você tem o direito de baixar. A responsabilidade pelo uso é
de quem opera o servidor e o app.

# Stack de homologação — docker compose (backend Medusa)

Stack self-contained para subir o backend store-b2c (Medusa 2.19) com os plugins POS
de pagamentos em containers, sem depender do ambiente de dev. O backend roda como
**standalone**: a imagem carrega apenas o `.medusa/server` produzido pelo
`pnpm build` (o `postBuild.js` reinstala as deps de produção dentro dele).

> Este stack é para homologação/testes locais. O fluxo de desenvolvimento continua
> sendo o `docker-compose.yml` da raiz + `pnpm dev` / `pnpm ib` (ver "Diferenças do
> fluxo de dev" abaixo).

## Pré-requisitos

- Docker com BuildKit (default em versões recentes)
- Docker Compose **v2.20+** (os fragmentos usam `include:`; testado com o
  standalone `docker-compose` v2.24)

## Quickstart

A partir deste diretório (`deploy/`):

```bash
cp homolog.env.example .env   # preencha JWT_SECRET/COOKIE_SECRET e a senha do admin
docker-compose build          # constrói pos-backend:homolog
docker-compose up -d          # infra + bootstrap (migrate → sync-links → admin) + backend
docker-compose --profile seed run --rm seed   # opcional: seed demo (ato explícito)
curl -fs http://localhost:9000/health
```

O backend sobe em `http://localhost:9000` (admin em `/app`, login com as env
`MEDUSA_ADMIN_*`). Credenciais ficam **somente** no `.env` local (gitignored).

## Serviços

| Serviço | Imagem | Papel |
|---|---|---|
| `postgres` | postgres:17-alpine | banco do Medusa (healthcheck `pg_isready`) |
| `redis` | redis:7-alpine | event bus / workflow engine |
| `meilisearch` | getmeili/meilisearch:v1.49.0 | busca (só é usado se as env `MEILISEARCH_*` existirem) |

Sem MinIO de propósito: as imagens `minio/minio`/`minio/mc` foram purgadas do
Docker Hub (as tags do compose de dev do repo dão 404) e o `quay.io/minio`
passou a exigir autenticação. S3 é opcional no Medusa — sem as env `S3_*` o
storage cai para local efêmero dentro do container.
| `migrate` | pos-backend:homolog | one-shot `db:migrate`, roda a cada `up` |
| `sync-links` | pos-backend:homolog | one-shot `db:sync-links`, após o migrate |
| `ensure-admin` | pos-backend:homolog | one-shot idempotente: cria o admin se não existir |
| `backend` | pos-backend:homolog | app Medusa, porta 9000, healthcheck em `/health` |
| `seed` | pos-backend:homolog | profile `seed`, one-shot manual |

### Por que one-shots explícitos no bootstrap

O script `init-backend` do repo (por trás do `pnpm ib`) é idempotente **checando se
já existe usuário**: depois do primeiro boot ele pula também o `db:migrate` — numa
imagem atualizada, migrations novas não rodariam — e depende de `child_process.exec`
(shell). No stack, cada passo é um serviço explícito e re-executável: migrations
rodam a cada `up`, e o admin é garantido por `src/scripts/ensure-admin.ts`
(checa antes de criar; o `medusa user` do CLI falharia em duplicado e travaria o
`up` seguinte via `depends_on`).

### Por que o seed é manual

Boot padrão determinístico: o seed demo (região Brasil como primeira região, BRL,
produtos, `metadata.pos.payment_methods` com os ids reais dos providers) é um ato
explícito do operador via profile `seed`. O seed é idempotente por design
(preenche `metadata.pos` só quando ausente).

## Variáveis de ambiente (`deploy/.env`)

| Variável | Obrigatória | Para quê |
|---|---|---|
| `JWT_SECRET`, `COOKIE_SECRET` | **sim** — o compose recusa subir sem elas | assinam sessões/tokens admin; o core não tem fallback em produção |
| `MEDUSA_ADMIN_EMAIL`, `MEDUSA_ADMIN_PASSWORD` | recomendado | admin criado pelo one-shot `ensure-admin` |
| `POS_PAYMENTS_MANUAL` | não (default `true`) | sobe os providers manuais/terminal-presente: `card`, `pix`, `cash`, `transfer` (`pp_pos-terminal_<id>`) |
| `POS_PAYMENTS_MP_TEST` | não (default `false`) | sobe o adapter Mercado Pago Point — sandbox apenas; deixe `false` sem credenciais |
| `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` | com `POS_PAYMENTS_MP_TEST=true` | credenciais sandbox do Mercado Pago (segredo — nunca no repo) |
| `ADMIN_CORS`, `AUTH_CORS`, `STORE_CORS` | não (defaults incluem o app de caixa Tauri) | origens liberadas |

Gere secrets com:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## Segurança

- `.env` é gitignored; o `.dockerignore` exclui `.env*` e `.npmrc` do contexto de
  build — o `postBuild.js` copiaria um `.env` presente no contexto para dentro da
  imagem, então nada de credencial entra em layer.
- Serviços com `init: true` (tini via daemon), `no-new-privileges`, backend roda
  como `USER node`, `mem_limit` definido.
- O backend avisa (e o core falha o boot sem secrets) se sessões ficarem sem
  assinatura adequada — não use placeholders em ambiente exposto.

## Variante distroless (experimental [pendente])

```bash
docker build --build-arg RUNNER=distroless -t pos-backend:homolog ../backend
```

Troca o runner `node:22-bookworm-slim` por `gcr.io/distroless/nodejs22-debian12:nonroot`
(superfície mínima, sem shell). **Antes de usar no compose**: os `command:` dos
one-shots e o healthcheck assumem a interface slim (ENTRYPOINT `tini` + `node` no
PATH); no distroless o próprio node é o ENTRYPOINT e não há `node` no PATH — os
comandos e o healthcheck precisam ser ajustados (e isso ainda não foi validado).

## Diferenças do fluxo de dev

| | dev (raiz do repo) | homologação (este diretório) |
|---|---|---|
| Infra | `docker-compose.yml` da raiz | `deploy/compose.db.yaml` (mesmas imagens, projeto `pos-homolog`) |
| Bootstrap | `pnpm ib` (init-backend) | one-shots do compose (migrate sempre roda) |
| App | `pnpm dev` / `pnpm start` | container `backend` (standalone `.medusa/server`) |
| Seed | automático no 1º boot via `init-backend` | profile `seed`, manual |

## E2E do fluxo POS

`backend/scripts/e2e-pos.mjs` replica o contrato do app de caixa por API (login
admin, `/pos/*`, draft order, payment collection/session, providers de terminal,
refund). Rode-o apontando para `http://localhost:9000` com o stack no ar e os env
`MEDUSA_ADMIN_*` do seu `.env` [pendente de validação contra o container].

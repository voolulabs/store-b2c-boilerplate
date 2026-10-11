# syntax=docker/dockerfile:1
# Imagem do backend Medusa (store-b2c) para o stack de homologação docker compose.
# Artefato final = standalone `.medusa/server`: o postBuild.js reinstala
# node_modules --prod DENTRO dele, então o runner não carrega nada além dele.
# Variantes de runner: runner-slim (padrão) e runner-distroless (swap futuro via
# --build-arg RUNNER=distroless). Os one-shots do compose assumem a interface
# slim (ENTRYPOINT tini + `node` no PATH); no distroless o próprio node é o
# ENTRYPOINT e não há `node` no PATH — revisar comandos/healthcheck no swap.
# Os dois ARG vivem antes do primeiro FROM: ARG declarado depois de um FROM
# fica no escopo do stage anterior e não é visível no FROM seguinte.
ARG NODE_VERSION=22.14
ARG RUNNER=slim

FROM node:${NODE_VERSION}-bookworm-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.10.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.10.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `pnpm build` = medusa build && node src/scripts/postBuild.js. O postBuild
# copia o lockfile e roda `pnpm i --prod --frozen-lockfile` dentro de
# .medusa/server — o standalone sai autocontido. O .env não existe no contexto
# (excluído pelo .dockerignore), então nada de credencial entra na layer.
# O medusa build carrega o medusa-config via ts-node e o src/lib/constants.ts
# afirma DATABASE_URL/JWT_SECRET/COOKIE_SECRET no import — os dummies abaixo
# existem só para satisfazer isso e nunca rodam: o runtime recebe env do
# compose (e os valores não estão na lista de weak-secrets do repo).
RUN DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    JWT_SECRET=build-stage-placeholder-not-a-secret-0123456789abcdef \
    COOKIE_SECRET=build-stage-placeholder-not-a-secret-fedcba9876543210 \
    pnpm build

FROM node:${NODE_VERSION}-bookworm-slim AS runner-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/.medusa/server /app
USER node
EXPOSE 9000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "node_modules/@medusajs/cli/cli.js", "start"]

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runner-distroless
WORKDIR /app
COPY --from=build /app/.medusa/server /app
EXPOSE 9000
# ENTRYPOINT do distroless é o próprio node: o CMD é o script + argumentos.
CMD ["node_modules/@medusajs/cli/cli.js", "start"]

FROM runner-${RUNNER} AS runner

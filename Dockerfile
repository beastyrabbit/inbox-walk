# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.app.json tsconfig.node.json vite.config.ts biome.json index.html ./
COPY src ./src
COPY server ./server
RUN pnpm build && pnpm exec sentry-cli sourcemaps inject dist dist-server

# Export the exact injected JavaScript and maps used by the runtime candidate.
FROM scratch AS sourcemaps
COPY --from=build /app/dist /dist
COPY --from=build /app/dist-server /dist-server
COPY --from=build /app/package.json /package.json

FROM build AS runtime-files
RUN find dist -type f -name '*.map' -delete && pnpm prune --prod

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/data
ENV CODEX_MODEL=gpt-5.6-sol
WORKDIR /app

RUN mkdir -p /data && chown node:node /data

COPY --from=runtime-files --chown=node:node /app/package.json ./package.json
COPY --from=runtime-files --chown=node:node /app/node_modules ./node_modules
COPY --from=runtime-files --chown=node:node /app/dist ./dist
COPY --from=runtime-files --chown=node:node /app/dist-server ./dist-server

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--import", "./dist-server/instrument.js", "dist-server/index.js"]

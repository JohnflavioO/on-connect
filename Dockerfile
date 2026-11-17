# syntax=docker/dockerfile:1

# One Dockerfile, three images: `--target api`, `--target worker`, `--target sessions`.

FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# Manifests first, so the dependency layer is reused until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/sessions/package.json apps/sessions/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm -r build

# Self-contained production trees: compiled code plus production
# dependencies only, no dev tooling and no source.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @on-connect/api deploy --prod --legacy /out/api \
 && pnpm --filter @on-connect/worker deploy --prod --legacy /out/worker \
 && pnpm --filter @on-connect/sessions deploy --prod --legacy /out/sessions


FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Never run as root inside the container.
USER node


FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
ENV API_HOST=0.0.0.0
ENV API_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.API_PORT+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]


FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker ./
CMD ["node", "dist/main.js"]


FROM runtime AS sessions
COPY --from=build --chown=node:node /out/sessions ./
CMD ["node", "dist/main.js"]

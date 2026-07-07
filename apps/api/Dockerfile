# SAOS API. Build context = repo ROOT (monorepo workspaces).
# Node 24 runs the TypeScript sources directly (type stripping) — the same
# way dev runs them, so there is no separate compile step to drift.
FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Manifests first for layer caching. @saos/db rides along so migrations and
# seeds run from this image (one-shot compose commands at deploy).
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspace=@saos/api --workspace=@saos/db --workspace=@saos/shared --omit=dev

COPY apps/api apps/api
COPY packages packages

EXPOSE 3001
# No curl in slim images — health check via node's own fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:3001/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "apps/api/src/index.ts"]

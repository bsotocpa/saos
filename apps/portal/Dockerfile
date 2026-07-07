# SAOS client portal (Next.js). Build context = repo ROOT.
FROM node:24-bookworm-slim

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# The /api rewrite proxies to the API service inside the compose network.
ENV API_URL=http://api:3001

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/portal/package.json apps/portal/
RUN npm ci --workspace=@saos/portal

COPY apps/portal apps/portal
RUN npm run build --workspace=@saos/portal

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace=@saos/portal"]

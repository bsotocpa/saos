# SAOS internal/staff app (Next.js). Build context = repo ROOT.
FROM node:24-bookworm-slim

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV API_URL=http://api:3001

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/internal/package.json apps/internal/
RUN npm ci --workspace=@saos/internal

COPY apps/internal apps/internal
RUN npm run build --workspace=@saos/internal

ENV NODE_ENV=production
EXPOSE 3005
CMD ["npm", "run", "start", "--workspace=@saos/internal"]

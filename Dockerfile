FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# ── Install dependencies ──────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# ── Build TypeScript ──────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm build

# ── Production image ─────────────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist dist/
COPY public/ public/

ENV PORT=3003
EXPOSE 3003

CMD ["node", "dist/server.js"]

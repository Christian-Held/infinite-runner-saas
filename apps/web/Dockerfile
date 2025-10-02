FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile=false

FROM deps AS builder
RUN pnpm --filter web build

FROM base AS runner
WORKDIR /app/apps/web
ENV NODE_ENV=production
RUN pnpm add --global serve
COPY --from=builder /app/apps/web/dist ./dist
EXPOSE 8080
CMD ["serve", "-s", "dist", "-l", "8080"]

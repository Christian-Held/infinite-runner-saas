FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile=false

FROM deps AS builder
RUN pnpm --filter @srv/playtester build
RUN pnpm prune --prod

FROM base AS runner
WORKDIR /app/services/playtester
ENV NODE_ENV=production
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --from=builder /app/services/playtester/dist ./dist
COPY --from=builder /app/services/playtester/package.json ./package.json
EXPOSE 9100
CMD ["node", "dist/index.js"]

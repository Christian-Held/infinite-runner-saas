FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile=false

FROM deps AS builder
RUN pnpm --filter api build
RUN pnpm prune --prod

FROM base AS runner
WORKDIR /app/apps/api
ENV NODE_ENV=production
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/package.json ./package.json
COPY --from=builder /app/apps/api/data ./data
VOLUME ["/app/apps/api/data"]
EXPOSE 3000
CMD ["node", "dist/app.js"]

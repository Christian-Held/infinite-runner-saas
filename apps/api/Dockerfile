FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=development
RUN corepack enable
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
RUN pnpm install
EXPOSE 3000
CMD ["pnpm", "dev"]

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=development
RUN corepack enable
COPY package.json ./
COPY tsconfig*.json ./
COPY vite.config.ts ./
COPY index.html ./
COPY src ./src
RUN pnpm install
EXPOSE 5173
CMD ["pnpm", "dev", "--host", "0.0.0.0", "--port", "5173"]

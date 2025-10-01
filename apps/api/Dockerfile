FROM node:20-alpine
WORKDIR /usr/src/app
ENV NODE_ENV=development
RUN apk add --no-cache python3 make g++
RUN corepack enable
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
RUN pnpm install
RUN mkdir -p data
VOLUME ["/usr/src/app/data"]
EXPOSE 3000
CMD ["pnpm", "dev"]

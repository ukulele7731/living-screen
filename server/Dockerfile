# «Живой экран» — сервер. Два этапа: сборка TypeScript, затем тонкий образ только с prod-зависимостями.
# better-sqlite3 и sharp ставятся готовыми бинарниками под glibc (bookworm), компилятор не нужен.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]

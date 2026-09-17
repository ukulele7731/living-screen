# «Живой экран» — сервер. Два этапа: сборка TypeScript, затем тонкий образ только с prod-зависимостями.
# better-sqlite3 и sharp несут готовые бинарники внутри пакета (prebuilds/), компилятор не нужен.
# --ignore-scripts: иначе npm по умолчанию запускает node-gyp rebuild для пакета с binding.gyp
# и падает без python/g++ — а собирать из исходников и не требуется.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# стартуем от root: приложение само поправит права на смонтированную data/ и перейдёт на node (src/privileges.ts)
RUN mkdir -p /app/data && chown node:node /app/data
EXPOSE 3000
CMD ["node", "dist/index.js"]

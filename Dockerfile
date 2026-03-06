FROM node:22-bookworm-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

RUN npx -y playwright@1.58.2 install --with-deps chromium

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./package.json
COPY --from=build /app/dist ./dist

CMD ["node", "dist/index.js"]

FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY webui/package.json webui/package.json
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src src
COPY shared shared
COPY scripts scripts
COPY webui/index.html webui/tsconfig.json webui/vite.config.ts ./webui/
COPY webui/src webui/src
RUN npm run build && npm run verify:sandbox

FROM node:24.22.2-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY webui/package.json webui/package.json
# Remove dev roots so type-only peers are omittable; retain optional native codecs.
RUN npm pkg delete devDependencies && npm ci --omit=dev --omit=peer --workspaces=false --ignore-scripts && npm cache clean --force

FROM node:24.22.2-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=96 --max-semi-space-size=4"
WORKDIR /app
COPY --from=dependencies --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json LICENSE ./
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/webui/dist ./webui/dist
RUN mkdir -p /app/data/misaka && chown node:node /app/data/misaka && chmod 700 /app/data/misaka
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]

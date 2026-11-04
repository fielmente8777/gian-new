# syntax=docker/dockerfile:1

# A Dockerfile is the recipe for an image. This one has several stages:
#   deps    = Node + all packages. docker-compose.yml uses it for local development.
#   build   = compiles TypeScript to dist/ and removes dev packages.
#   runtime = the small image for servers: no compiler, no dev packages, not root.
# Build the server image with: docker build -t gian-new .

FROM node:24-alpine AS base
WORKDIR /app

FROM base AS deps
# Copy only these two files first: Docker reuses this step until they change,
# so editing your code does not reinstall every package.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
# tini passes Docker's stop signal to Node, so Server.stop() can finish open requests
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/health/live || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

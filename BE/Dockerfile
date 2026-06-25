# Built from the REPO ROOT as context (ADR-003) so the @pp/shared workspace resolves.
#   docker build -f BE/Dockerfile .

# --- build: install workspace deps, bundle BE (esbuild inlines @pp/shared + socket.io) ---
FROM node:22-alpine AS build
WORKDIR /app
# package manifests first for layer caching; all four are needed for `npm ci` to validate
# the lockfile against the full workspace graph.
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/package.json
COPY BE/package.json BE/package.json
COPY FE/package.json FE/package.json
RUN npm ci --ignore-scripts
COPY shared/ shared/
COPY BE/ BE/
RUN npm run build --workspace @pp/be

# --- runtime: just node + the self-contained bundle. No node_modules required. ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /app/BE/dist/server.cjs ./server.cjs
EXPOSE 3000
USER node
CMD ["node", "server.cjs"]

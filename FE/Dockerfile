# Built from the REPO ROOT as context (ADR-003) so the @pp/shared workspace resolves.
#   docker build -f FE/Dockerfile .

# --- build: install workspace deps, produce the static SPA (vite runs svelte-kit sync) ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/package.json
COPY BE/package.json BE/package.json
COPY FE/package.json FE/package.json
RUN npm ci --ignore-scripts
COPY shared/ shared/
COPY FE/ FE/
RUN npm run build --workspace @pp/fe

# --- runtime: nginx serving the static output with the SPA fallback ---
FROM nginx:alpine AS runtime
# Drop the stock nginx welcome page; the SPA emits 200.html (not index.html), so a
# leftover default index.html would otherwise be served at "/".
RUN rm -rf /usr/share/nginx/html/*
COPY FE/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/FE/build /usr/share/nginx/html
EXPOSE 80

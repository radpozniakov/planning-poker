# Built from the REPO ROOT as context (ADR-003) so the @pp/shared workspace resolves.
#   docker build -f FE/Dockerfile .

# --- build: install workspace deps, produce the static SPA (vite build) ---
FROM node:24-alpine AS build
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
# Drop the stock nginx welcome page; the SPA emits its own index.html, so we clear
# nginx's default index.html first — otherwise the stock page would shadow the SPA at "/".
RUN rm -rf /usr/share/nginx/html/*
COPY FE/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/FE/build /usr/share/nginx/html
EXPOSE 80

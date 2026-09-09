# --- Build stage ---
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/frontend ./apps/frontend

RUN npm ci
RUN npm run build:packages
RUN npm run build --workspace @sqlpilot/frontend

# --- Runtime stage ---
FROM nginx:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/frontend/dist/sqlpilot/browser /usr/share/nginx/html
EXPOSE 80

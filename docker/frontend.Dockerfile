# --- Build stage ---
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
# Only @sqlpilot/shared is used by the frontend — the other packages (sql-parser,
# ai, database) pull in native addons (better-sqlite3, etc.) that this image has
# no build toolchain for and does not need.
COPY packages/shared ./packages/shared
COPY apps/frontend ./apps/frontend

RUN npm ci
RUN npm run build --workspace @sqlpilot/shared
RUN npm run build --workspace @sqlpilot/frontend

# --- Runtime stage ---
FROM nginx:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/frontend/dist/sqlpilot/browser /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

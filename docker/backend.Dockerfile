# --- Build stage ---
FROM node:20-bookworm-slim AS build
WORKDIR /repo

# better-sqlite3 needs a toolchain to compile its native addon
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/backend ./apps/backend

RUN npm ci
RUN npm run build:packages
RUN npm run build:backend

# Prune dev dependencies for the runtime image
RUN npm prune --omit=dev

# --- Runtime stage ---
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/backend/dist ./dist
COPY --from=build /repo/apps/backend/package.json ./package.json

EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]

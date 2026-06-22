# =============================================================================
# Stage 1: Build frontend (Svelte 5)
# =============================================================================
FROM node:22-alpine AS frontend
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# =============================================================================
# Stage 2: Install backend deps
# =============================================================================
FROM oven/bun:alpine AS backend
WORKDIR /app
COPY backend-bun/package.json backend-bun/bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY backend-bun/ ./

# =============================================================================
# Stage 3: Runtime
# =============================================================================
FROM oven/bun:alpine
WORKDIR /app
COPY --from=backend /app/node_modules ./node_modules
COPY --from=backend /app/src ./src
COPY --from=backend /app/migrations ./migrations
COPY --from=backend /app/package.json ./
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

ENV STREAMVAULT_DASHBOARD_DIR=/app/dashboard
EXPOSE 8080

ENTRYPOINT ["./entrypoint.sh"]

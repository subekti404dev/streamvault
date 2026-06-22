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
# Stage 2: Build backend binary (Bun compile)
# =============================================================================
FROM oven/bun:alpine AS backend
WORKDIR /app
COPY backend-bun/package.json backend-bun/bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY backend-bun/ ./
RUN bun build --compile src/index.ts --outfile streamvault

# =============================================================================
# Stage 3: Runtime
# =============================================================================
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /app/streamvault .
COPY --from=frontend /app/dashboard/dist ./dashboard
COPY backend-bun/entrypoint.sh .
RUN chmod +x entrypoint.sh

ENV STREAMVAULT_DASHBOARD_DIR=/app/dashboard
EXPOSE 8080

ENTRYPOINT ["./entrypoint.sh"]

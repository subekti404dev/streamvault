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
# Stage 2: Build backend (Rust)
# =============================================================================
FROM rust:slim AS backend
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release 2>/dev/null || true
COPY backend/ ./
RUN touch src/main.rs && cargo build --release

# =============================================================================
# Stage 3: Runtime
# =============================================================================
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /app/target/release/streamvault .
COPY --from=frontend /app/dashboard/dist ./dashboard
COPY docker/entrypoint.sh .
RUN chmod +x entrypoint.sh

ENV STREAMVAULT_DASHBOARD_DIR=/app/dashboard
EXPOSE 8080

ENTRYPOINT ["./entrypoint.sh"]

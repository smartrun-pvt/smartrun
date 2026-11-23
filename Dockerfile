# Build Stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests (package-lock.json required for deterministic npm ci)
COPY package.json package-lock.json ./

# Install dependencies deterministically without running lifecycle/postinstall scripts
RUN npm ci --ignore-scripts

# Copy source files
COPY . .

# Note: scripts/patch-capacitor-android.mjs only patches Android Java sources under
# node_modules/@capacitor* and is not needed for the web/Cloud Run Node.js build.

# Build Vite client and bundle server.ts -> dist/server.cjs
RUN npm run build

# Production Stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy package manifests including lockfile for deterministic production install
COPY package.json package-lock.json ./

# Install only production dependencies without running lifecycle/postinstall scripts
RUN npm ci --omit=dev --ignore-scripts

# Copy built distribution bundle from builder stage
COPY --from=builder /app/dist ./dist
# Copy public assets, configurations and data files
COPY --from=builder /app/public ./public
COPY --from=builder /app/data ./data
COPY --from=builder /app/firebase-applet-config.json* ./

# Expose port (Google Cloud Run dynamically routes to PORT, default 8080)
EXPOSE 8080

# Start server
CMD ["node", "dist/server.cjs"]

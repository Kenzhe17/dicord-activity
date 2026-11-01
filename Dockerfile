# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Force cache busting
RUN echo "Build timestamp: $(date)"

# Copy package files
COPY package*.json ./
COPY apps/web/package*.json ./apps/web/
COPY apps/server/package*.json ./apps/server/
COPY packages/shared/package*.json ./packages/shared/

# Install dependencies
RUN npm install

# Copy source files
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
COPY apps/server ./apps/server

# Build shared package FIRST
RUN cd packages/shared && npm run build

# Build frontend
RUN cd apps/web && npm run build

# Build backend
RUN cd apps/server && npm run build

# Production stage
FROM node:18-alpine AS runner

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY apps/server/package*.json ./apps/server/
COPY packages/shared/package*.json ./packages/shared/

# Install production dependencies only
RUN npm install --production

# Copy built files
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Set environment
ENV NODE_ENV=production
ENV PORT=3001

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start server
CMD ["node", "apps/server/dist/index.js"]

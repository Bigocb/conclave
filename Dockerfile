FROM node:20-slim AS base

# Install openssl for crypto ops, postgresql-client for healthchecks
RUN apt-get update && apt-get install -y openssl postgresql-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci && npm cache clean --force

# Copy source code
COPY . .

# Build (tsc with noEmit:false produces dist/)
RUN npm run build

# Production stage
FROM node:20-slim
WORKDIR /app

COPY --from=base /app/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./
COPY --from=base /app/drizzle.config.ts ./
COPY --from=base /app/src/db/schema.ts ./src/db/schema.ts
COPY --from=base /app/fleet.example.yaml ./fleet.example.yaml

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/main.js"]
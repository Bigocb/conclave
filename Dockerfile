FROM node:20-slim AS base

# Install openssl for Prisma-like crypto operations and postgres client for healthchecks
RUN apt-get update && apt-get install -y openssl postgresql-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only for final image)
RUN npm ci --omit=dev && npm cache clean --force

# Copy source code
COPY . .

# Build the project
RUN npm run build

# Production stage
FROM node:20-slim
WORKDIR /app

COPY --from=base /app/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./
COPY --from=base /app/conclave-local.db ./conclave-local.db
COPY --from=base /app/fleet.yaml ./fleet.yaml
COPY --from=base /app/src/db/schema.sql ./src/db/schema.sql

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/server/index.js"]
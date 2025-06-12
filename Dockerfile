# ---- Base Stage ----
FROM node:18-alpine AS base
WORKDIR /usr/src/app
RUN apk add --no-cache libc6-compat
COPY package*.json ./

# ---- Dependencies Stage ----
FROM base AS dependencies
ENV NODE_ENV=production
RUN npm ci

# ---- Release Stage ----
FROM base AS release
WORKDIR /usr/src/app
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
COPY ./src ./src

# Create a non-root user and switch to it
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 7000
CMD ["node", "src/index.js"]

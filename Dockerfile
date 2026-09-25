# Small, non-root production image. Runs on any Docker host (Render, Cloud Run, a VM).
# Node 24 LTS (Node 20 reached end-of-life in April 2026). The test suite is run on Node 20 and 24.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

USER node
# The host injects PORT (Render: 10000, Cloud Run: 8080) and the app binds to it on 0.0.0.0.
EXPOSE 8080
CMD ["node", "server.js"]

FROM node:22-slim AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --production

FROM node:22-slim

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./

COPY src/ ./src/
COPY viewer/ ./viewer/
COPY dashboard/ ./dashboard/
COPY bounties/ ./bounties/
COPY chat/ ./chat/
COPY landing/ ./landing/
COPY tools/ ./tools/
COPY assets/ ./assets/
COPY docs/ ./docs/
COPY leaderboard/ ./leaderboard/
COPY profiles/ ./profiles/

ENV NODE_ENV=production
ENV PORT=3000
ENV TICK_RATE=1000
ENV DRY_RUN=true

EXPOSE 3000

CMD ["node", "src/index.js"]

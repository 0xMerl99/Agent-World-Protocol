FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY src/ ./src/
COPY viewer/ ./viewer/
COPY dashboard/ ./dashboard/
COPY landing/ ./landing/
COPY tools/ ./tools/
COPY assets/ ./assets/

ENV NODE_ENV=production
ENV PORT=3000
ENV TICK_RATE=1000
ENV DRY_RUN=true

EXPOSE 3000

CMD ["node", "src/index.js"]

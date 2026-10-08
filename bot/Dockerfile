FROM node:20-bookworm-slim

WORKDIR /srv/bot
ENV NODE_ENV=production

# git: o Baileys puxa uma dependência direto do GitHub durante o npm ci
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY media ./media

# sessão do WhatsApp e grupo vinculado ficam no volume; o processo não roda como root
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
USER node

EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

FROM node:20-bookworm-slim

WORKDIR /srv/app
ENV NODE_ENV=production

# sqlite3 baixa binário pronto; as ferramentas de build só são usadas se não houver
# binário para a arquitetura (ex.: algum ARM incomum).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

# dados ficam no volume; o processo não roda como root
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

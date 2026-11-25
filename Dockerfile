# Bridge image: small, non-root, production dependencies only.
#   docker build -t rc-omnichannel-bridge .
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3001 \
    MAPPING_FILE=/app/data/mapping.json

WORKDIR /app

# Install dependencies first so code changes do not invalidate this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY index.js ./
COPY src ./src
COPY scripts/rc-bootstrap.js ./scripts/rc-bootstrap.js

# mapping.json, the Telegram offset and uploaded documents all live in /app/data (a volume).
RUN mkdir -p /app/data /app/debug-dumps && chown -R node:node /app/data /app/debug-dumps
USER node
VOLUME ["/app/data"]

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]

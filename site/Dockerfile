# Build from the repo root: docker build -f site/Dockerfile .
# The site imports the shared JS client from lib/js.
FROM node:22-bookworm-slim

WORKDIR /app/site
# Run as the image's unprivileged node user; it owns /app so the build output
# and wrangler's .wrangler/state persistence stay writable.
# workerd (wrangler 4.15x) needs system CA certificates for outbound TLS.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && chown node:node /app /app/site
USER node

COPY --chown=node:node site/package.json site/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY --chown=node:node lib/js /app/lib/js
COPY --chown=node:node site/ .
RUN npm run build \
  && sed -i 's/\r$//' docker-entrypoint.sh \
  && chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=4180
EXPOSE 4180

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4180)+'/api/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]

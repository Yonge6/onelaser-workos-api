FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc -p tsconfig.build.json
COPY tools/fetch-frontend.mjs ./tools/fetch-frontend.mjs
COPY deploy/frontend-revision.txt ./deploy/frontend-revision.txt
RUN node tools/fetch-frontend.mjs /frontend

FROM caddy:2 AS edge

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=10000 FRONTEND_CONNECTED=true XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY --from=build --chown=node:node /frontend ./public
COPY --from=edge /usr/bin/caddy /usr/bin/caddy
COPY deploy/Caddyfile deploy/container-start.sh ./deploy/
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bash", "/app/deploy/container-start.sh"]

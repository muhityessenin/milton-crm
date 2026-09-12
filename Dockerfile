FROM node:22-alpine AS dependencies

WORKDIR /app
RUN npm install --global pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    STORAGE_BACKEND=postgres

WORKDIR /app
RUN apk add --no-cache tini && mkdir -p /app/uploads && chown -R node:node /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node storage ./storage
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts

USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

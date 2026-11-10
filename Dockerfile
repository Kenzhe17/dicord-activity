FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY games ./games
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate && pnpm build
RUN pnpm --filter @rize/server --prod deploy --legacy /production/server

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production ARCADE_ENV=production ARCADE_AUTH_MODE=discord ARCADE_HOST=0.0.0.0 ARCADE_SERVE_WEB=true ARCADE_ENABLE_TEST_GAME=false
COPY --from=build --chown=node:node /production/server ./apps/server
COPY --from=build --chown=node:node /workspace/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3001
CMD ["node", "apps/server/dist/index.js"]

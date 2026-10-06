FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/build ./build
COPY --from=build /app/migrations ./migrations
# The readiness check and the image smoke (`migrate.js --check`) read these at
# runtime; no Railway service runs a preDeploy after Wave 2.0 (migrations, grants
# and retention run in GitHub Actions as gm_migrator).
COPY --from=build /app/scripts/grants.sql ./scripts/grants.sql
COPY --from=build /app/scripts/db/post-migrate.sql ./scripts/db/post-migrate.sql
# Stamped by CD (scripts/ops/stamp-build.mjs) so /api/version reports the build.
COPY --from=build /app/build-info.json ./build-info.json
USER node
EXPOSE 3001
# instrument.js loads and validates configuration before the app (SEC-9, DB-1).
# The worker service overrides the start command with build/server/worker.js.
CMD ["node","--import","./build/server/instrument.js","build/server/index.js"]

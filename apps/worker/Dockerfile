FROM node:22-bookworm-slim
RUN corepack enable && npx playwright install-deps chromium
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @autohands/api prisma generate && pnpm --filter @autohands/browser-runner exec playwright install chromium
CMD ["pnpm", "--filter", "@autohands/worker", "start"]

# Production image. Bun runs .tsx directly — no compile step.
#
# Entry: src/api/index.tsx boots the Hono server on $PORT.
# Scheduled machines launch their own command (bun run cli ingest/etc.)
# and exit — they share this image but not the CMD.

FROM oven/bun:1 AS base
WORKDIR /app

# Install deps with frozen lockfile. Copy package.json + bun.lock first
# so Docker caches the install layer across source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# App source.
COPY . .

# Build the admin client islands (HTMX-compatible vanilla JS bundles)
# into public/build/. The page templates reference these via
# /assets/build/<bundle>.js, served from public/. public/build is
# gitignored, so the bundle MUST be produced at image-build time —
# without this step, admin pages 404 the script tags and click-to-
# comment / prompt-editor stop working.
RUN bun run build:admin

# Entrypoint materialises GCP_SA_KEY (if present) into a file where
# the BigQuery SDK expects to find it.
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
RUN chmod +x /app/scripts/entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["bun", "run", "src/api/index.tsx"]

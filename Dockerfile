# Bops' web server, hosted (1on1 Realtors fork: bop.1on1realtors.com). Not the Mac app: this runs the
# same Next server the app ships (.next/standalone), behind the login gate (lib/gate.ts).
# Build: docker build -t bops-1on1 .   Deploy: docs/1on1-realtors.md (Fly or Render).
# No secret is baked in: every key comes from the host's secret store at run time.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# The Electron binary and electron-builder are for the Mac app only.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY . .
RUN npx next build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=8080 \
    BOPS_SELF_HOSTED=1 \
    BOPS_LOGIN_GATE=google
# ca-certificates for the calls out (Orgo, OpenAI, Google, the CRM); tini so signals reach Node.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 bops
COPY --from=build --chown=bops:bops /app/.next/standalone ./
COPY --from=build --chown=bops:bops /app/.next/static ./.next/static
COPY --from=build --chown=bops:bops /app/public ./public
# The 1on1 tools (WhatsApp export reader, agent inbox sorter) run with Node from here: node realty/cli/...
# Node 22 needs --experimental-strip-types for them; the npm scripts pass it.
COPY --from=build --chown=bops:bops /app/realty ./realty
# State (.data/: chats, bots, settings) lives on the host's volume mounted here, so a deploy keeps it.
RUN mkdir -p /app/.data && chown bops:bops /app/.data
USER bops
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]

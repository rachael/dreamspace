#!/usr/bin/env bash
# Publish the static site to Cloudflare Pages: https://pico-vibe-xr.pages.dev
# (workshop at /workshop/, examples at /examples/). No build step.
#
# Token: CLOUDFLARE_PAGES_DEPLOY_TOKEN (Account.Cloudflare Pages:Edit) from
# life/projects/j4me/infra/.env. The life/.env CLOUDFLARE_API_TOKEN is DNS-only
# and cannot deploy Pages. Project was created via the REST API because
# wrangler >=4.139 redirects `pages project create` to Workers.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/../j4me/infra/.env"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Ship only what the pages use: no CLAUDE.md, run-of-show, or media index.
cp -r "$ROOT"/{index.html,README.md,examples,src,theme,docs,assets} "$STAGE/"
mkdir -p "$STAGE/workshop"
cp "$ROOT/workshop/index.html" "$STAGE/workshop/"
cp -r "$ROOT/workshop/media" "$STAGE/workshop/"
rm -f "$STAGE/workshop/media/INDEX.md" "$STAGE/theme/README.md"

set -a
. <(grep -E '^CLOUDFLARE_(PAGES_DEPLOY_TOKEN|ACCOUNT_ID)=' "$ENV_FILE" | tr -d '\r')
set +a
cd "$STAGE"
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PAGES_DEPLOY_TOKEN" \
  npx wrangler pages deploy . --project-name pico-vibe-xr --branch main --commit-dirty=true

#!/bin/zsh
# Fires the gate's re-check. Vercel Hobby only allows a daily cron, so this Mac calls the endpoint every 6 h.
# Outbound HTTPS only; nothing listens on this machine. Secret is read from .env at run time, never stored elsewhere.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
SECRET="$(grep -E '^CRON_SECRET=' "$ROOT/.env" | cut -d= -f2- | tr -d "\"'")"
DOMAIN="$(python3 -c "import json;print(json.load(open('$ROOT/gate.config.json'))['hosting']['verify_domain'])")"
[[ -z "$SECRET" || -z "$DOMAIN" ]] && { echo "$(date -u +%FT%TZ) missing CRON_SECRET or verify_domain"; exit 1; }
OUT="$(curl -sS --max-time 90 -H "Authorization: Bearer $SECRET" "https://$DOMAIN/api/cron/sweep" -w ' HTTP%{http_code}' 2>&1)"
echo "$(date -u +%FT%TZ) $OUT" | cut -c1-400

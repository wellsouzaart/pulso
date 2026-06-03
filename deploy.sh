#!/bin/bash
# Deploy Pulso para Cloudflare Workers
# Uso: bash deploy.sh
# Requer: export CLOUDFLARE_API_TOKEN="seu-token"

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "Erro: defina CLOUDFLARE_API_TOKEN antes de rodar"
  exit 1
fi

/usr/local/bin/fnm exec --using=22 npx wrangler deploy

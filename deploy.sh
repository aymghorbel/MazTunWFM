#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Deploy or update Mazarine WFM on a Linux VM with Docker
# Usage:
#   First time : ./deploy.sh
#   Update     : git pull && ./deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILE="docker-compose.full.yml"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Mazarine WFM — Deploy                         ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── 1. Check Docker ───────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "✗ Docker not found. Run setup-vm.sh first."
  exit 1
fi

# ── 2. Create .env from example if missing ───────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  .env file created from .env.example                        ║"
  echo "║  Edit it now before continuing:                              ║"
  echo "║                                                              ║"
  echo "║    nano .env                                                 ║"
  echo "║                                                              ║"
  echo "║  Set DB_PASSWORD, JWT_SECRET, and CORS_ORIGIN, then         ║"
  echo "║  run this script again.                                      ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  exit 0
fi

# ── 3. Validate .env has required values ─────────────────────────────────────
source .env

if [ -z "$DB_PASSWORD" ] || [ "$DB_PASSWORD" = "ChangeMeStrong123!" ]; then
  echo "✗ Please set a real DB_PASSWORD in .env"
  exit 1
fi
if [ -z "$JWT_SECRET" ] || [ "$JWT_SECRET" = "replace-with-64-random-characters-minimum" ]; then
  echo "✗ Please set a real JWT_SECRET in .env"
  exit 1
fi
if [ -z "$CORS_ORIGIN" ] || echo "$CORS_ORIGIN" | grep -q "YOUR_VM_IP"; then
  echo "✗ Please set a real CORS_ORIGIN in .env  (e.g. http://$(hostname -I | awk '{print $1}'):3000)"
  exit 1
fi

echo "▶ Configuration:"
echo "   CORS_ORIGIN : $CORS_ORIGIN"
echo "   DB_PASSWORD : ****"
echo "   JWT_SECRET  : ****"
echo ""

# ── 4. Build and start containers ─────────────────────────────────────────────
echo "▶ Building and starting containers..."
docker compose -f "$COMPOSE_FILE" up -d --build

# ── 5. Wait for API to be healthy ─────────────────────────────────────────────
echo "▶ Waiting for API to be ready..."
MAX_WAIT=60
WAITED=0
until docker exec mazarine-api node -e "
  const http=require('http');
  http.get('http://localhost:3001/api/company-settings',r=>{
    process.exit(r.statusCode<500?0:1);
  }).on('error',()=>process.exit(1));
" 2>/dev/null; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "   Timeout — checking logs..."
    docker logs mazarine-api --tail=20
    exit 1
  fi
  printf "."
  sleep 3
  WAITED=$((WAITED+3))
done
echo " ready!"

# ── 6. Run migrations ─────────────────────────────────────────────────────────
echo "▶ Running database migrations..."
docker exec mazarine-api node migrations/init.js

# ── 7. Done ───────────────────────────────────────────────────────────────────
VM_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✅  Deployment complete!                                    ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║                                                              ║"
printf "║  App  :  %-51s║\n" "$CORS_ORIGIN"
printf "║  Also :  %-51s║\n" "http://$VM_IP:3000"
echo "║                                                              ║"
echo "║  Login: superadmin@mazarine.tn                               ║"
echo "║  Pass : Maz@Admin2025!                                       ║"
echo "║                                                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Useful commands:"
echo "  View logs   : docker compose -f docker-compose.full.yml logs -f"
echo "  Stop        : docker compose -f docker-compose.full.yml down"
echo "  Update      : git pull && ./deploy.sh"
echo ""

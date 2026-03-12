#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-vm.sh — Run ONCE on a fresh Ubuntu 22.04 / 24.04 VM (as root or sudo)
# Installs Docker, Docker Compose, and opens required firewall ports.
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Mazarine WFM — VM Setup                       ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── 1. System update ──────────────────────────────────────────────────────────
echo "▶ Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

# ── 2. Install Docker ─────────────────────────────────────────────────────────
echo "▶ Installing Docker..."
apt-get install -y -qq ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu \
$(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

systemctl enable docker
systemctl start docker

echo "   Docker:         $(docker --version)"
echo "   Docker Compose: $(docker compose version)"

# ── 3. Add current user to docker group (no sudo needed for docker) ───────────
if [ -n "$SUDO_USER" ]; then
  usermod -aG docker "$SUDO_USER"
  echo "▶ Added $SUDO_USER to docker group (re-login to apply)"
fi

# ── 4. Firewall ───────────────────────────────────────────────────────────────
echo "▶ Configuring firewall (ufw)..."
if command -v ufw &>/dev/null; then
  ufw allow 22/tcp   comment "SSH"    > /dev/null
  ufw allow 80/tcp   comment "HTTP"   > /dev/null
  ufw allow 443/tcp  comment "HTTPS"  > /dev/null
  ufw allow 3000/tcp comment "App"    > /dev/null
  ufw --force enable > /dev/null
  echo "   Firewall rules applied (22, 80, 443, 3000)"
else
  echo "   ufw not found — skip firewall config"
fi

echo ""
echo "✅  VM setup complete. Run deploy.sh next."
echo ""

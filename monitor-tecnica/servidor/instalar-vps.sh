#!/bin/bash
# Instala el servidor del Monitor de Técnica en una VPS con Ubuntu 22.04 / 24.04 (o Debian 12).
# Deja el panel en https://TU-DOMINIO con certificado automático (Caddy) y el servidor
# como servicio que arranca solo.
#
# Uso (como root, desde la carpeta "servidor"):
#   sudo bash instalar-vps.sh tecnica.tuiglesia.org tu-email@ejemplo.com
#
# Antes: el dominio tiene que apuntar (registro A) a la IP de la VPS.
# Se puede volver a ejecutar para actualizar: no pisa config.json ni los datos.
set -euo pipefail

DOMINIO="${1:-}"; EMAIL="${2:-}"
if [[ -z "$DOMINIO" || -z "$EMAIL" ]]; then
  echo "Uso: sudo bash instalar-vps.sh DOMINIO EMAIL"; exit 1
fi
[[ $EUID -eq 0 ]] || { echo "Ejecutalo con sudo."; exit 1; }

ORIGEN="$(cd "$(dirname "$0")" && pwd)"
DESTINO=/opt/monitor-tecnica
export DEBIAN_FRONTEND=noninteractive

echo "==> Paquetes base"
apt-get update -q
apt-get install -y -q curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Caddy (HTTPS automático)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "==> Archivos del servidor en $DESTINO"
id monitor >/dev/null 2>&1 || useradd --system --home "$DESTINO" --shell /usr/sbin/nologin monitor
mkdir -p "$DESTINO"
cp -r "$ORIGEN/server.js" "$ORIGEN/package.json" "$ORIGEN/package-lock.json" "$ORIGEN/public" "$ORIGEN/config.ejemplo.json" "$DESTINO/"
(cd "$DESTINO" && npm ci --omit=dev --no-fund --no-audit)

NUEVO=0
if [[ ! -f "$DESTINO/config.json" ]]; then
  NUEVO=1
  TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
  CLAVE=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")
  node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1] + "/config.ejemplo.json", "utf8"));
    Object.assign(c, { puerto: 8080, host: "127.0.0.1", token: process.argv[2], claveDashboard: process.argv[3], contactoPush: "mailto:" + process.argv[4] });
    fs.writeFileSync(process.argv[1] + "/config.json", JSON.stringify(c, null, 2) + "\n");
  ' "$DESTINO" "$TOKEN" "$CLAVE" "$EMAIL"
fi
chown -R monitor:monitor "$DESTINO"
chmod 600 "$DESTINO/config.json"

echo "==> Servicio"
cat > /etc/systemd/system/monitor-tecnica.service <<EOF
[Unit]
Description=Monitor de Técnica
After=network-online.target
Wants=network-online.target

[Service]
User=monitor
WorkingDirectory=$DESTINO
ExecStart=$(command -v node) $DESTINO/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DESTINO

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now monitor-tecnica
systemctl restart monitor-tecnica

echo "==> HTTPS para $DOMINIO"
cat > /etc/caddy/Caddyfile <<EOF
{
  email $EMAIL
}

$DOMINIO {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
EOF
systemctl reload caddy || systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

sleep 2
systemctl is-active --quiet monitor-tecnica && echo "Servidor: funcionando" || { echo "El servidor no arrancó:"; journalctl -u monitor-tecnica -n 30 --no-pager; exit 1; }

echo
echo "Listo: https://$DOMINIO"
if [[ $NUEVO -eq 1 ]]; then
  echo
  echo "  Clave del panel:   $CLAVE"
  echo "  Token de agentes:  $TOKEN"
  echo
  echo "  Guardalos. En cada PC de la iglesia:"
  echo "  powershell -ExecutionPolicy Bypass -File .\\instalar.ps1 -Servidor https://$DOMINIO -Token $TOKEN -NombreEquipo PC-VMIX"
fi
echo
echo "Configuración: $DESTINO/config.json  (después de editarla: sudo systemctl restart monitor-tecnica)"
echo "Registro:      sudo journalctl -u monitor-tecnica -f"

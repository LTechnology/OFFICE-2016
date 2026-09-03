#!/usr/bin/env bash
# Paso 2: descarga de arribos EZE/AEP para la fecha objetivo y los baselines.
# Va directo contra la API que alimenta la tabla (descubierta interceptando
# las XHR con scripts/capturar.js); c=3000 devuelve el día completo.
set -euo pipefail

API="https://webaa-api-h4d5amdfcze7hthn.a02.azurefd.net/web-prod/v1/api-aa/all-flights"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
mkdir -p data/raw

for arpt in EZE AEP; do
  # Baselines originales pedidos (viernes 28-08, 11-09, 18-09) devuelven 0-7
  # vuelos: la API solo publica una ventana de ~-2/+5 días. Se usan como
  # baseline todos los días disponibles alrededor del 04-09.
  for fecha in 04-09-2026 01-09-2026 02-09-2026 03-09-2026 05-09-2026 06-09-2026 07-09-2026 08-09-2026; do
    alias=$(echo "$arpt" | tr '[:upper:]' '[:lower:]')
    out="data/raw/${alias}_${fecha}.json"
    echo "[get] $arpt $fecha"
    curl -sS --fail "$API?c=3000&idarpt=$arpt&movtp=A&f=$fecha" \
      -H "Origin: https://www.aeropuertosargentina.com" \
      -H "Referer: https://www.aeropuertosargentina.com/" \
      -H "User-Agent: $UA" -o "$out.tmp"
    python3 -c "import json,sys; p=json.load(open('$out.tmp')); print('  vuelos:', len(p))"
    mv "$out.tmp" "$out"
    sleep 2.5
  done
done
echo "[ok] descargas completas"

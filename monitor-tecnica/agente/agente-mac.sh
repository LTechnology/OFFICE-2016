#!/bin/bash
# Monitor de Técnica - agente para macOS / Linux.
# Uso: agente-mac.sh http://SERVIDOR:8080 TOKEN [NOMBRE_EQUIPO] [INTERVALO]
SERVIDOR="${1%/}"; TOKEN="$2"; EQUIPO="${3:-$(hostname -s)}"; INTERVALO="${4:-60}"
renice -n 19 $$ >/dev/null 2>&1

json_str() { local s="${1//[[:cntrl:]]/}"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }

if [[ "$(uname)" == "Darwin" ]]; then
  BOOT=$(sysctl -n kern.boottime | sed -E 's/.*sec = ([0-9]+).*/\1/')
  INICIO=$(date -u -r "$BOOT" +%Y-%m-%dT%H:%M:%SZ)
  usuario() { stat -f %Su /dev/console; }
else
  usuario() { who | awk 'NR==1{print $1}'; }
  INICIO=$(date -u -d "$(uptime -s)" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
fi

enviar() {
  curl -s -m 8 -o /dev/null -X POST "$SERVIDOR/api/latido" \
    -H "X-Token: $TOKEN" -H 'Content-Type: application/json' --data-binary "$1"
}

trap 'enviar "{\"equipo\":$(json_str "$EQUIPO"),\"evento\":\"apagando\"}"; exit 0' TERM INT

while true; do
  PROCS=$(ps -axco comm= | sort -u | while IFS= read -r p; do json_str "$p"; printf ','; done)
  enviar "{\"equipo\":$(json_str "$EQUIPO"),\"inicioSistema\":\"$INICIO\",\"usuario\":$(json_str "$(usuario 2>/dev/null)"),\"procesos\":[${PROCS%,}]}"
  sleep "$INTERVALO" & wait $!
done

# Monitor de Técnica - agente para Windows.
# Cada N segundos manda al servidor un "latido" con la lista de procesos abiertos.
# Corre con prioridad mínima (Idle): sólo usa CPU cuando nadie más la necesita.
# Si el servidor no responde, no reintenta ni acumula nada: espera al próximo latido.
param(
  [string]$Config = (Join-Path $PSScriptRoot 'agente.config.json'),
  [string]$Evento = ''
)

$ErrorActionPreference = 'SilentlyContinue'
try { (Get-Process -Id $PID).PriorityClass = 'Idle' } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$cfg = Get-Content -Raw -Path $Config | ConvertFrom-Json
$equipo = if ($cfg.nombreEquipo) { $cfg.nombreEquipo } else { $env:COMPUTERNAME }
$intervalo = if ($cfg.intervaloSegundos) { [int]$cfg.intervaloSegundos } else { 60 }
$url = $cfg.servidor.TrimEnd('/') + '/api/latido'
$headers = @{ 'X-Token' = $cfg.token }

$inicio = $null
try { $inicio = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o') } catch {}

function Enviar($datos, $timeout) {
  $json = $datos | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  try {
    Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body $bytes `
      -ContentType 'application/json; charset=utf-8' -TimeoutSec $timeout -UseBasicParsing | Out-Null
  } catch {}
}

if ($Evento) {
  Enviar @{ equipo = $equipo; evento = $Evento } 4
  exit
}

$usuario = $null
$vuelta = 0
while ($true) {
  if ($vuelta % 5 -eq 0) {
    try { $usuario = (Get-CimInstance Win32_ComputerSystem).UserName } catch {}
  }
  $procesos = @(Get-Process | Select-Object -ExpandProperty ProcessName -Unique)
  Enviar @{ equipo = $equipo; inicioSistema = $inicio; usuario = $usuario; procesos = $procesos } 8
  $vuelta++
  Start-Sleep -Seconds $intervalo
}

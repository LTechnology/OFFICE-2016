# Monitor de Técnica - agente para Windows.
# Cada N segundos manda al servidor un "latido" con la lista de procesos abiertos
# y las conexiones de Escritorio remoto (RDP) activas.
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

# Carpeta compartida con el icono de la bandeja (que corre como el usuario logueado).
$control = Join-Path $PSScriptRoot 'control'
$marcaDetenido = Join-Path $control 'detenido'
$archivoEstado = Join-Path $control 'estado.json'

function Enviar($datos, $timeout) {
  $json = $datos | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  try {
    Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body $bytes `
      -ContentType 'application/json; charset=utf-8' -TimeoutSec $timeout -UseBasicParsing | Out-Null
    return $true
  } catch { return $false }
}

if ($Evento) {
  Enviar @{ equipo = $equipo; evento = $Evento } 4 | Out-Null
  exit
}

# Al arrancar Windows el monitor siempre vuelve a estar activo.
Remove-Item -Force $marcaDetenido

$inicio = $null
try { $inicio = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o') } catch {}

$puertoRdp = 3389
try {
  $puertoRdp = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp').PortNumber
} catch {}

function ConexionesRemotas {
  $lista = @()
  # Escritorio remoto de Windows: conexión establecida al puerto RDP.
  try {
    Get-NetTCPConnection -LocalPort $puertoRdp -State Established -ErrorAction Stop |
      Select-Object -ExpandProperty RemoteAddress -Unique |
      ForEach-Object { $lista += @{ tipo = 'Escritorio remoto (RDP)'; desde = $_ } }
  } catch {}
  return $lista
}

# Programas de acceso remoto que usan el mismo .exe para todo y cambian sólo el
# modo con que arrancan (ej. "anydesk --service" vs. el proceso de la sesión).
# Se informan como "nombre --modo" para poder reconocer la sesión desde el servidor.
$conModo = 'anydesk', 'anydeskmsi', 'rustdesk'
function ProcesosExtra {
  $extra = @()
  if (Get-Process -Name $conModo -ErrorAction SilentlyContinue) {
    $filtro = ($conModo | ForEach-Object { "Name='$_.exe'" }) -join ' OR '
    Get-CimInstance Win32_Process -Filter $filtro | ForEach-Object {
      $n = $_.Name -replace '\.exe$', ''
      $modo = if ($_.CommandLine -match '\s(--?[\w-]+)') { $Matches[1] } else { '(sin modo)' }
      $extra += "$n $modo".ToLower()
    }
  }
  return @($extra | Sort-Object -Unique)
}

# Último ID de AnyDesk que se conectó a esta PC (registro propio de AnyDesk).
function UltimoIdAnyDesk {
  $archivo = Join-Path $env:ProgramData 'AnyDesk\connection_trace.txt'
  try {
    # AnyDesk lo guarda en UTF-16 sin BOM (al menos en Windows); se detecta por los bytes
    # para no depender de la versión. Se abre compartido porque AnyDesk lo tiene abierto.
    $fs = New-Object IO.FileStream($archivo, 'Open', 'Read', 'ReadWrite')
    try {
      $largo = [Math]::Min($fs.Length, 16384)
      [void]$fs.Seek(-$largo, 'End')
      $bytes = New-Object byte[] $largo
      [void]$fs.Read($bytes, 0, $largo)
    } finally { $fs.Dispose() }
    $utf16 = $largo -ge 2 -and ($bytes[0] -eq 0 -or $bytes[1] -eq 0)
    if ($utf16 -and $largo % 2) { $bytes = $bytes[1..($largo - 1)] }
    $texto = if ($utf16) { [Text.Encoding]::Unicode.GetString($bytes) } else { [Text.Encoding]::UTF8.GetString($bytes) }
    $linea = $texto -split "`r?`n" | Where-Object { $_ -match '^\s*Incoming' } | Select-Object -Last 1
    if ($linea -match '(\d{9,10})\s*$') { return $Matches[1] }
  } catch {}
  return $null
}

$usuario = $null
$vuelta = 0
$detenido = $false
while ($true) {
  if (Test-Path $marcaDetenido) {
    if (-not $detenido) {
      $quien = (Get-Content $marcaDetenido | Select-Object -First 1)
      Enviar @{ equipo = $equipo; evento = 'detenido'; usuario = $quien } 8 | Out-Null
      $detenido = $true
    }
    Start-Sleep -Seconds 5
    continue
  }
  $detenido = $false

  if ($vuelta % 5 -eq 0) {
    try { $usuario = (Get-CimInstance Win32_ComputerSystem).UserName } catch {}
  }
  $extra = @(ProcesosExtra)
  $procesos = @(Get-Process | Select-Object -ExpandProperty ProcessName -Unique) + $extra
  $datos = @{ equipo = $equipo; inicioSistema = $inicio; usuario = $usuario; procesos = $procesos; remoto = @(ConexionesRemotas) }
  if ($extra -match '^anydesk') { $datos.anydeskId = UltimoIdAnyDesk }
  $ok = Enviar $datos 8

  $ahora = (Get-Date).ToUniversalTime().ToString('o')
  $estado = @{ ultimoIntento = $ahora; ok = $ok; intervalo = $intervalo }
  if ($ok) { $estado.ultimoOk = $ahora } elseif (Test-Path $archivoEstado) {
    try { $estado.ultimoOk = (Get-Content -Raw $archivoEstado | ConvertFrom-Json).ultimoOk } catch {}
  }
  $estado | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 $archivoEstado
  $vuelta++

  # Espera en tramos cortos para reaccionar rápido si cierran el monitor desde el icono.
  for ($s = 0; $s -lt $intervalo -and -not (Test-Path $marcaDetenido); $s += 5) { Start-Sleep -Seconds 5 }
}

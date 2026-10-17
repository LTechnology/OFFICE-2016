# Instala el agente del Monitor de Técnica en esta PC (ejecutar como Administrador).
# Ejemplo:
#   powershell -ExecutionPolicy Bypass -File .\instalar.ps1 -Servidor http://192.168.1.10:8080 -Token MI-CLAVE
param(
  [Parameter(Mandatory = $true)][string]$Servidor,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$NombreEquipo = $env:COMPUTERNAME,
  [int]$IntervaloSegundos = 60
)

$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Hay que ejecutar este script como Administrador.' -ForegroundColor Red
  exit 1
}

$destino = Join-Path $env:ProgramData 'MonitorTecnica'
New-Item -ItemType Directory -Force -Path $destino | Out-Null
foreach ($f in 'agente.ps1', 'icono.ps1', 'icono.vbs') { Copy-Item -Force (Join-Path $PSScriptRoot $f) $destino }
# Carpeta donde el icono (usuario común) y el agente (SYSTEM) se comunican.
$control = Join-Path $destino 'control'
New-Item -ItemType Directory -Force -Path $control | Out-Null
icacls $control /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
@{ servidor = $Servidor; token = $Token; nombreEquipo = $NombreEquipo; intervaloSegundos = $IntervaloSegundos } |
  ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $destino 'agente.config.json')

$script = Join-Path $destino 'agente.ps1'
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$argsBase = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""

# Tarea 1: arranca con Windows, como SYSTEM (sin ventana), prioridad baja, sin límite de tiempo.
$accion = New-ScheduledTaskAction -Execute $ps -Argument $argsBase
$disparador = New-ScheduledTaskTrigger -AtStartup
$cuenta = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$ajustes = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 7 `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'MonitorTecnica' -Action $accion -Trigger $disparador -Principal $cuenta `
  -Settings $ajustes -Force | Out-Null

# Tarea 2: avisa "me estoy apagando" cuando alguien apaga o reinicia la PC (evento 1074).
schtasks /Create /F /TN 'MonitorTecnica-Apagado' /RU SYSTEM /SC ONEVENT /EC System `
  /MO "*[System[(EventID=1074)]]" /TR "`"$ps`" $argsBase -Evento apagando" | Out-Null

# Tarea 3: icono en la bandeja para cada usuario que inicia sesión.
$accionIcono = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "`"$(Join-Path $destino 'icono.vbs')`""
$usuarios = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
$ajustesIcono = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -MultipleInstances Parallel
Register-ScheduledTask -TaskName 'MonitorTecnica-Icono' -Action $accionIcono -Trigger (New-ScheduledTaskTrigger -AtLogOn) `
  -Principal $usuarios -Settings $ajustesIcono -Force | Out-Null

# Si ya estaba instalado, reinicia el agente para que use la versión nueva.
Stop-ScheduledTask -TaskName 'MonitorTecnica' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'MonitorTecnica'
Start-ScheduledTask -TaskName 'MonitorTecnica-Icono'
Write-Host "Listo. '$NombreEquipo' ya debería aparecer en el panel ($Servidor)." -ForegroundColor Green

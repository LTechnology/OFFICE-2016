# Ayuda a descubrir qué proceso aparece SOLO durante una sesión remota
# (AnyDesk, TeamViewer, etc.), para agregarlo a "accesoRemoto" en el config del servidor.
# Uso: ejecutarlo en la PC sin nadie conectado y seguir las instrucciones.

function Foto {
  Get-CimInstance Win32_Process | ForEach-Object {
    $n = $_.Name -replace '\.exe$', ''
    $arg = if ($_.CommandLine -match '\s(--?[\w-]+)') { " $($Matches[1])" } else { '' }
    "$n$arg"
  } | Sort-Object -Unique
}

Write-Host '1) Asegurate de que NADIE esté conectado por remoto a esta PC.' -ForegroundColor Cyan
Read-Host '   Presioná Enter para tomar la primera foto'
$antes = Foto
Write-Host '2) Ahora conectate por remoto desde otra compu (AnyDesk, TeamViewer, etc.).' -ForegroundColor Cyan
Read-Host '   Cuando la sesión esté abierta, presioná Enter'
$durante = Foto
$nuevos = $durante | Where-Object { $antes -notcontains $_ }
Write-Host ''
if ($nuevos) {
  Write-Host 'Procesos que aparecieron con la conexión remota:' -ForegroundColor Green
  $nuevos | ForEach-Object { Write-Host "   $_" }
  Write-Host ''
  Write-Host 'Agregá los nombres SIN "--algo" en "accesoRemoto" del config del servidor.'
  Write-Host 'Si sólo aparecen nombres con "--algo", ese programa necesita un ajuste en el agente.'
} else {
  Write-Host 'No apareció ningún proceso nuevo: este programa no se puede detectar por procesos.' -ForegroundColor Yellow
}

# Quita el agente del Monitor de Técnica de esta PC (ejecutar como Administrador).
Stop-ScheduledTask -TaskName 'MonitorTecnica' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'MonitorTecnica' -Confirm:$false -ErrorAction SilentlyContinue
schtasks /Delete /F /TN 'MonitorTecnica-Apagado' 2>$null | Out-Null
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*MonitorTecnica*agente.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -Recurse -Force (Join-Path $env:ProgramData 'MonitorTecnica') -ErrorAction SilentlyContinue
Write-Host 'Agente desinstalado.' -ForegroundColor Green

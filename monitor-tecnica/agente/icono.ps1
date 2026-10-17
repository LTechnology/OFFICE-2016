# Monitor de Técnica - icono en la bandeja del sistema (abajo a la derecha).
# Sólo muestra el estado: el monitoreo lo hace el agente de fondo (agente.ps1).
#   Verde   = conectado al servidor
#   Naranja = funcionando pero sin conexión con el servidor
#   Gris    = esperando al agente
# "Cerrar monitor" detiene el monitoreo de esta PC hasta que se reinicie o
# alguien vuelva a iniciar sesión, y le avisa al equipo de técnica.

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
try { (Get-Process -Id $PID).PriorityClass = 'Idle' } catch {}

# Una sola instancia por sesión de usuario.
$creado = $false
$mutex = New-Object Threading.Mutex($true, 'Local\MonitorTecnicaIcono', [ref]$creado)
if (-not $creado) { exit }

$dir = $PSScriptRoot
$control = Join-Path $dir 'control'
$marcaDetenido = Join-Path $control 'detenido'
$archivoEstado = Join-Path $control 'estado.json'
$cfg = Get-Content -Raw (Join-Path $dir 'agente.config.json') | ConvertFrom-Json
$panel = $cfg.servidor.TrimEnd('/') + '/'

# Si el usuario vuelve a iniciar sesión, el monitor se reactiva.
Remove-Item -Force $marcaDetenido -ErrorAction SilentlyContinue

function Circulo([Drawing.Color]$color) {
  $bmp = New-Object Drawing.Bitmap 16, 16
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.FillEllipse((New-Object Drawing.SolidBrush $color), 1, 1, 14, 14)
  $g.DrawEllipse((New-Object Drawing.Pen ([Drawing.Color]::FromArgb(90, 0, 0, 0))), 1, 1, 13, 13)
  $g.Dispose()
  [Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$iconos = @{
  ok    = Circulo ([Drawing.Color]::FromArgb(22, 163, 74))
  error = Circulo ([Drawing.Color]::FromArgb(217, 119, 6))
  nada  = Circulo ([Drawing.Color]::FromArgb(156, 163, 175))
}

$icono = New-Object Windows.Forms.NotifyIcon
$menu = New-Object Windows.Forms.ContextMenuStrip
$itemEstado = $menu.Items.Add('Monitor de Técnica')
$itemEstado.Enabled = $false
[void]$menu.Items.Add('-')
$itemPanel = $menu.Items.Add('Abrir panel')
$itemPanel.add_Click({ Start-Process $panel })
$itemCerrar = $menu.Items.Add('Cerrar monitor…')
$itemCerrar.add_Click({
  $r = [Windows.Forms.MessageBox]::Show(
    "Se va a dejar de monitorear esta computadora hasta que se reinicie o se vuelva a iniciar sesión.`n`nAl equipo de técnica le va a llegar un aviso. ¿Cerrar el monitor?",
    'Monitor de Técnica', 'YesNo', 'Question')
  if ($r -ne 'Yes') { return }
  Set-Content -Path $marcaDetenido -Value $env:USERNAME
  $icono.Visible = $false
  [Windows.Forms.Application]::Exit()
})
$icono.ContextMenuStrip = $menu
$icono.add_DoubleClick({ Start-Process $panel })

function Actualizar {
  $texto = 'Esperando al agente…'
  $ic = $iconos.nada
  try {
    $e = Get-Content -Raw $archivoEstado -ErrorAction Stop | ConvertFrom-Json
    $limite = [int]$e.intervalo * 3
    $ultimoOk = if ($e.ultimoOk) { [DateTime]::Parse($e.ultimoOk).ToUniversalTime() } else { [DateTime]::MinValue }
    $ultimoIntento = [DateTime]::Parse($e.ultimoIntento).ToUniversalTime()
    $ahora = [DateTime]::UtcNow
    if (($ahora - $ultimoIntento).TotalSeconds -gt $limite) {
      $texto = 'El agente no está funcionando'
    } elseif (($ahora - $ultimoOk).TotalSeconds -le $limite) {
      $texto = 'Activo · conectado (' + $ultimoOk.ToLocalTime().ToString('HH:mm') + ')'
      $ic = $iconos.ok
    } else {
      $texto = 'Activo · sin conexión con el servidor'
      $ic = $iconos.error
    }
  } catch {}
  $itemEstado.Text = $texto
  $icono.Text = ('Monitor de Técnica: ' + $texto).Substring(0, [Math]::Min(63, ('Monitor de Técnica: ' + $texto).Length))
  $icono.Icon = $ic
}

Actualizar
$icono.Visible = $true
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 10000
$timer.add_Tick({ Actualizar })
$timer.Start()

[Windows.Forms.Application]::Run()
$timer.Dispose()
$icono.Dispose()
$mutex.ReleaseMutex()

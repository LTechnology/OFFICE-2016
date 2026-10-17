# Monitor de Técnica

Sistema para saber **en tiempo real** qué computadoras del equipo de técnica están prendidas,
qué programas tienen abiertos (vMix, ProPresenter, grandMA…), si los proyectores y el ATEM están
encendidos, y recibir **notificaciones en el celular** cuando algo queda prendido fuera de horario,
se apaga mal o alguien se conecta por AnyDesk.

```
  Iglesia                                              Internet (VPS)
  ─────────────────────────────                        ──────────────────────────────
  PC vMix ─────── ping ──► ATEM   ─┐
  PC Proyección ─ ping ──► 2 proy. ─┼─ latido cada 60 s ─►  Servidor  ──►  Panel web / app
  PC Iluminación ──────────────────┘   (HTTPS)              (Node)    ──►  Notificaciones push
                                                                       ──►  Telegram / ntfy (opcional)
```

## Qué detecta

| Evento | Cuándo |
|---|---|
| 🟢 Encendida | Una PC empieza a mandar señal (incluye a qué hora arrancó Windows) |
| ⚪ Apagada | Alguien apagó o reinició la PC correctamente |
| 🟠 Dejó de responder | Se cortó la señal sin aviso: botón de apagado, corte de luz, sin red |
| ▶️ / ⏹️ Programa abierto / cerrado | Se abrió o cerró un programa de la lista |
| 🚨 Fuera de horario | La PC (o un equipo en red) está prendida fuera de los horarios permitidos. Se repite cada 30 min mientras siga así |
| 🔌 Dispositivo | Un equipo con IP (consola, proyector, nodo DMX…) se prendió o se apagó |
| 🖥️ Conexión remota | Alguien se conectó (o desconectó) por Escritorio remoto de Windows (con la IP de origen), TeamViewer, Chrome Remote Desktop, RustDesk… |
| ⏸️ Monitor cerrado | Alguien cerró el monitor desde el iconito de la bandeja (con el usuario de Windows) |

Todo queda guardado en `servidor/datos/eventos.jsonl` y se ve en el panel.

## ¿Afecta a las PCs de vivo?

No debería. El agente fue pensado para eso:

- Es un script de PowerShell que ya viene con Windows: **no se instala nada**.
- Corre con **prioridad mínima (Idle)**: sólo usa CPU cuando ningún otro programa la necesita.
- Una vez por minuto lista los procesos (tarda milisegundos) y manda un mensaje chico (~5 KB).
- Si el servidor está caído o no hay internet, **no hace nada**: no reintenta, no acumula, no muestra ventanas.
- No toca los programas, no lee pantallas, no graba nada.

Igual, recomendamos instalarlo primero en una PC y probarlo un ensayo antes de un culto.

## 1. Instalar el servidor en una VPS (recomendado)

Así el panel se ve desde cualquier lado y los avisos siguen llegando aunque en la iglesia se
corte la luz (justamente cuando más sirve el aviso "dejó de responder").

1. **Contratá una VPS** con Ubuntu 24.04. Alcanza con la más chica (1 GB de RAM).
2. **Apuntá el dominio**: en el DNS de `tecnicaidc.com.ar` creá un registro **A** para
   `monitor` con la IP de la VPS (queda `monitor.tecnicaidc.com.ar`).
3. **Copiá la carpeta `servidor`** a la VPS y ejecutá, dentro de ella:

   ```bash
   sudo bash instalar-vps.sh monitor.tecnicaidc.com.ar tu-email@ejemplo.com
   ```

   El script instala Node.js y Caddy, deja el servidor como servicio (arranca solo si la VPS se
   reinicia) y saca el certificado HTTPS automáticamente. Al final muestra la **clave del panel**
   y el **token de los agentes**: guardalos.
4. Editá `/opt/monitor-tecnica/config.json` (IPs de los proyectores y el ATEM, horarios) y
   reiniciá con `sudo systemctl restart monitor-tecnica`.

Para actualizar, copiá la carpeta nueva y volvé a ejecutar el mismo comando: no pisa la
configuración ni el historial.

### Sin VPS (en una PC de la red)

Con [Node.js](https://nodejs.org) 18 o más nuevo:

```bash
cd monitor-tecnica/servidor
npm install
cp config.ejemplo.json config.json   # y editalo (ver abajo)
node server.js
```

Abrí `http://IP-DEL-SERVIDOR:8080`. Ojo: sin HTTPS las notificaciones push no funcionan
(los navegadores las exigen); quedan Telegram y ntfy.

El historial y el estado se guardan en `servidor/datos/`. Si hiciste pruebas antes de dejarlo
funcionando de verdad, borrá esa carpeta para arrancar con el registro limpio.

## 2. Instalar el agente en cada PC Windows

Copiar la carpeta `agente` a la PC, abrir **PowerShell como Administrador** en esa carpeta y ejecutar:

```powershell
powershell -ExecutionPolicy Bypass -File .\instalar.ps1 -Servidor https://monitor.tecnicaidc.com.ar -Token EL-TOKEN -NombreEquipo PC-VMIX
```

`-NombreEquipo` tiene que coincidir con el nombre en `equipos` del config: `PC-VMIX`, `PC-PROYECCION` o `PC-ILUMINACION`.

Esto crea tres tareas programadas (se ven en el Programador de tareas de Windows):
- `MonitorTecnica`: el agente. Arranca con Windows, sin ventana, prioridad baja.
- `MonitorTecnica-Apagado`: avisa al servidor cuando alguien apaga o reinicia la PC.
- `MonitorTecnica-Icono`: el iconito de la bandeja, para cada usuario que inicia sesión.

### El iconito (abajo a la derecha)

Es un circulito de color en la bandeja del sistema:

- 🟢 **Verde**: funcionando y conectado al servidor.
- 🟠 **Naranja**: funcionando, pero sin conexión con el servidor (revisar red o servidor).
- ⚪ **Gris**: el agente de fondo no está corriendo.

Con clic derecho se ve el estado, se puede **abrir el panel**, o **cerrar el monitor**. Al cerrarlo,
Windows pide confirmación, la PC deja de monitorearse hasta que se reinicie o alguien vuelva a
iniciar sesión, y al equipo de técnica le llega un aviso ⏸️ con el usuario que lo cerró.
El icono sólo muestra el estado: si se cuelga o se termina con el Administrador de tareas,
el monitoreo de fondo sigue funcionando.

> Si el icono queda escondido en la flechita `^`, se puede arrastrar a la barra para que quede siempre visible.

Para quitarlo: `powershell -ExecutionPolicy Bypass -File .\desinstalar.ps1` (como Administrador).

### En Mac

```bash
./agente-mac.sh https://monitor.tecnicaidc.com.ar EL-TOKEN PC-PROPRESENTER-MAC
```

Para que arranque solo, agregalo como *LaunchAgent* (`~/Library/LaunchAgents`) o en
Ajustes → General → Ítems de inicio.

## Conexiones remotas

- **Escritorio remoto de Windows (RDP)**: se detecta siempre, con la IP desde donde se conectan.
- **AnyDesk, TeamViewer, Chrome Remote Desktop, RustDesk, Compartir pantalla de Mac**: vienen
  configurados en `accesoRemoto`. Se detectan por un proceso que sólo existe mientras hay alguien
  conectado. Para AnyDesk y RustDesk, que usan el mismo programa para todo, el agente informa
  también el modo con que arrancó cada proceso (por ejemplo `anydesk --service` o `anydesk --backend`).
- Para AnyDesk, además, el aviso incluye el último ID que se conectó, sacado del registro de
  conexiones del propio AnyDesk (`C:\ProgramData\AnyDesk\connection_trace.txt`). Requiere AnyDesk
  **instalado** (no la versión portable).

### AnyDesk: confirmado

Probado con una sesión real (AnyDesk instalado, Windows 11): mientras alguien está conectado
aparece el proceso `anydesk --backend`, que es lo que trae `accesoRemoto` por defecto.
AnyDesk anota la conexión en su registro apenas empieza la sesión, así que el aviso ya trae el ID.

Ese proceso pertenece a SYSTEM, y Windows sólo deja ver su línea de comando con permisos de
administrador. El agente instalado con `instalar.ps1` ya corre así. Si alguna vez corre sin esos
permisos, el panel muestra una advertencia ⚠️ en esa PC.

Si en una versión futura de AnyDesk deja de detectarse, ejecutá `agente\diagnostico-remoto.ps1`
**como Administrador** durante una conexión de prueba y copiá lo que aparece en `accesoRemoto`.

Como el agente informa una vez por minuto, una conexión de menos de un minuto puede pasar
desapercibida. Si hace falta más precisión, bajá `-IntervaloSegundos` a 30 al instalar.

## 3. Configuración (`servidor/config.json`)

| Campo | Para qué sirve |
|---|---|
| `token` | Clave que comparten el servidor y los agentes. Poné algo largo. |
| `claveDashboard` | Clave para entrar al panel. La sesión queda abierta un año en cada dispositivo; si cambiás la clave, se cierran todas. |
| `contactoPush` | Tu email como `mailto:...`. Lo exigen Apple y Google para mandar notificaciones push. |
| `host` | `127.0.0.1` en la VPS (sólo Caddy llega al servidor); vacío para escuchar en toda la red. |
| `zonaHoraria` | Para evaluar los horarios. Ej.: `America/Argentina/Buenos_Aires`. |
| `segundosSinSenal` | Cuánto esperar sin latidos antes de avisar "dejó de responder" (180 = 3 min). |
| `minutosRecordatorio` | Cada cuánto repetir el aviso de "fuera de horario". |
| `programas` | Programas a vigilar. `procesos` es el nombre del proceso sin `.exe`. Para saberlo: en el panel, **"Ver todos los procesos de esta compu"** con el programa abierto. ⚠️ Los de grandMA y Hog 4 del ejemplo hay que confirmarlos así. |
| `horarios` | Cuándo está **permitido** que las PCs estén prendidas. `dias`: `dom lun mar mie jue vie sab`. Fuera de estos horarios → 🚨. Pueden cruzar la medianoche (ej. `22:00` a `02:00`). |
| `equipos` | Las tarjetas del panel, en orden. Por PC: `alias` (nombre que se muestra), `programas` (cuáles se muestran en su tarjeta, en verde si están abiertos y en rojo si no) y, opcional, `horarios` propios. |
| `accesoRemoto` | Programas de acceso remoto: `procesos` que sólo aparecen mientras hay una sesión abierta. |
| `dispositivos` | Equipos con IP para controlar por ping (proyector, ATEM…). Con `"pc": "PC-STREAMING"` el ping lo hace esa compu (necesario si el servidor está en una VPS, porque desde internet no se llega a la red de la iglesia); sin `pc`, lo hace el servidor. Mientras esa compu está apagada, el equipo figura como "sin datos" (gris). `tipo` elige el ícono: `proyector`, `atem` u otro. También se les aplican los horarios. |
| `notificar` | Qué tipos de evento mandan notificación al celular. Sacá `programa_abierto` / `programa_cerrado` si molestan mucho. |

Después de cambiar el config, reiniciá el servidor. **Los agentes no hay que tocarlos**:
mandan todos los procesos y el servidor decide qué vigilar.

## 4. Notificaciones al celular

### En la app del panel (push)

Funcionan con el panel en HTTPS (la VPS). Cada persona las activa en su dispositivo con 🔔 →
**Activar notificaciones**, y puede mandarse una de prueba.

- **iPhone / iPad** (iOS 16.4 o más nuevo): Apple sólo permite notificaciones en webs
  **instaladas como app**. Abrí `https://monitor.tecnicaidc.com.ar` en **Safari** → botón
  **Compartir** → **Agregar a inicio**. Abrí la app "Técnica" desde la pantalla de inicio y ahí
  tocá 🔔. El panel lo explica si alguien lo intenta desde Safari sin instalar.
- **Android**: en Chrome alcanza con abrir la página y tocar 🔔 (opcional: menú ⋮ → *Instalar app*).
- **Compu**: Chrome, Edge o Firefox, tocando 🔔.

Qué avisos se mandan se elige en `notificar`. Si alguien desinstala la app o quita el permiso,
el servidor deja de mandarle automáticamente.

### Telegram o ntfy (opcional)

**Telegram** (sirve para un grupo con todo el equipo de técnica)
1. En Telegram, hablale a `@BotFather` → `/newbot` → copiá el token en `telegram.botToken`.
2. Agregá el bot a un grupo del equipo y mandá cualquier mensaje.
3. Abrí `https://api.telegram.org/bot<TOKEN>/getUpdates` y copiá el `chat.id` (número negativo para grupos) en `telegram.chatId`.

**ntfy** (sin cuentas)
1. Instalá la app *ntfy* en el celular y suscribite a un tema con un nombre difícil de adivinar (ej. `tecnica-iglesia-x7k2p`).
2. Poné ese nombre en `ntfy.tema`.

## Limitaciones a tener en cuenta

- Equipos sin computadora ni conexión de red (amplificadores, dimmers, la "planta") no se pueden
  ver directamente. Opción económica: enchufes inteligentes con medición de consumo
  (Shelly, Sonoff con Tasmota) que tienen IP y se pueden agregar como `dispositivos`.
- El aviso de apagado correcto depende de que la red siga viva unos segundos durante el apagado.
  Si no llega, igual aparece "dejó de responder" a los 3 minutos.
- Si la PC está prendida pero sin red, se ve como "dejó de responder".

# Monitor de Técnica

Sistema para saber **en tiempo real** qué computadoras del equipo de técnica están prendidas,
qué programas tienen abiertos (ProPresenter, OBS, vMix, luces…), y recibir **avisos en el
celular** cuando algo queda prendido fuera de horario o se apaga mal.

```
  PC Proyección ─┐
  PC Streaming  ─┼──(latido cada 60 s)──►  Servidor  ──►  Panel web en vivo
  PC Luces      ─┘                            │
  Consola / proyector ◄──(ping cada 60 s)─────┤
                                              └──►  Telegram / ntfy (celular)
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

Todo queda guardado en `servidor/datos/eventos.jsonl` y se ve en el panel.

## ¿Afecta a las PCs de vivo?

No debería. El agente fue pensado para eso:

- Es un script de PowerShell que ya viene con Windows: **no se instala nada**.
- Corre con **prioridad mínima (Idle)**: sólo usa CPU cuando ningún otro programa la necesita.
- Una vez por minuto lista los procesos (tarda milisegundos) y manda un mensaje chico (~5 KB).
- Si el servidor está caído o no hay internet, **no hace nada**: no reintenta, no acumula, no muestra ventanas.
- No toca los programas, no lee pantallas, no graba nada.

Igual, recomendamos instalarlo primero en una PC y probarlo un ensayo antes de un culto.

## 1. Instalar el servidor

Necesita una máquina que esté siempre prendida: una PC vieja, una Raspberry Pi, o un
servidor en la nube. Requiere [Node.js](https://nodejs.org) 18 o más nuevo (no hace falta `npm install`).

```bash
cd monitor-tecnica/servidor
cp config.ejemplo.json config.json   # y editalo (ver abajo)
node server.js
```

Abrí `http://IP-DEL-SERVIDOR:8080` en el navegador o el celular.

> **Para verlo desde afuera de la iglesia**, la forma más simple y segura es instalar
> [Tailscale](https://tailscale.com) (gratis) en el servidor y en los celulares del equipo.
> Si lo ponés en la nube, configurá `claveDashboard` y usalo detrás de HTTPS.

Para que el servidor arranque solo: en Windows, crear una tarea programada "al iniciar" con
`node server.js`; en Linux/Raspberry, un servicio de systemd o `pm2`.

## 2. Instalar el agente en cada PC Windows

Copiar la carpeta `agente` a la PC, abrir **PowerShell como Administrador** en esa carpeta y ejecutar:

```powershell
powershell -ExecutionPolicy Bypass -File .\instalar.ps1 -Servidor http://192.168.1.10:8080 -Token LA-MISMA-CLAVE-DEL-CONFIG
```

Opcional: `-NombreEquipo PC-PROYECCION` (por defecto usa el nombre de Windows).

Esto crea dos tareas programadas (se ven en el Programador de tareas de Windows):
- `MonitorTecnica`: arranca con Windows, sin ventana, prioridad baja.
- `MonitorTecnica-Apagado`: avisa al servidor cuando alguien apaga o reinicia la PC.

Para quitarlo: `powershell -ExecutionPolicy Bypass -File .\desinstalar.ps1` (como Administrador).

### En Mac

```bash
./agente-mac.sh http://192.168.1.10:8080 LA-CLAVE PC-PROPRESENTER-MAC
```

Para que arranque solo, agregalo como *LaunchAgent* (`~/Library/LaunchAgents`) o en
Ajustes → General → Ítems de inicio.

## 3. Configuración (`servidor/config.json`)

| Campo | Para qué sirve |
|---|---|
| `token` | Clave que comparten el servidor y los agentes. Poné algo largo. |
| `claveDashboard` | Si no está vacío, el panel pide esta clave (usuario: cualquiera). |
| `zonaHoraria` | Para evaluar los horarios. Ej.: `America/Argentina/Buenos_Aires`. |
| `segundosSinSenal` | Cuánto esperar sin latidos antes de avisar "dejó de responder" (180 = 3 min). |
| `minutosRecordatorio` | Cada cuánto repetir el aviso de "fuera de horario". |
| `programas` | Programas a vigilar. `procesos` es el nombre del proceso sin `.exe` (se ve en el Administrador de tareas → Detalles). |
| `horarios` | Cuándo está **permitido** que las PCs estén prendidas. `dias`: `dom lun mar mie jue vie sab`. Fuera de estos horarios → 🚨. Pueden cruzar la medianoche (ej. `22:00` a `02:00`). |
| `equipos` | Por nombre de PC: `alias` para mostrar y, si hace falta, `horarios` propios que reemplazan a los generales. |
| `dispositivos` | Equipos con IP para controlar por ping (consola, proyector…). También se les aplican los horarios. |
| `notificar` | Qué tipos de evento mandan notificación al celular. Sacá `programa_abierto` / `programa_cerrado` si molestan mucho. |

Después de cambiar el config, reiniciá el servidor. **Los agentes no hay que tocarlos**:
mandan todos los procesos y el servidor decide qué vigilar.

## 4. Notificaciones al celular

**Telegram** (recomendado: se puede usar un grupo con todo el equipo de técnica)
1. En Telegram, hablale a `@BotFather` → `/newbot` → copiá el token en `telegram.botToken`.
2. Agregá el bot a un grupo del equipo y mandá cualquier mensaje.
3. Abrí `https://api.telegram.org/bot<TOKEN>/getUpdates` y copiá el `chat.id` (número negativo para grupos) en `telegram.chatId`.

**ntfy** (aún más simple, sin cuentas)
1. Instalá la app *ntfy* en el celular y suscribite a un tema con un nombre difícil de adivinar (ej. `tecnica-iglesia-x7k2p`).
2. Poné ese nombre en `ntfy.tema`.

El panel web, si lo tenés abierto y le das permiso, también muestra notificaciones del navegador para los avisos 🚨.

## Limitaciones a tener en cuenta

- Equipos sin computadora ni conexión de red (amplificadores, dimmers, la "planta") no se pueden
  ver directamente. Opción económica: enchufes inteligentes con medición de consumo
  (Shelly, Sonoff con Tasmota) que tienen IP y se pueden agregar como `dispositivos`.
- El aviso de apagado correcto depende de que la red siga viva unos segundos durante el apagado.
  Si no llega, igual aparece "dejó de responder" a los 3 minutos.
- Si la PC está prendida pero sin red, se ve como "dejó de responder".

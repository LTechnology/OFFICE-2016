// Monitor de Técnica: servidor central.
// Recibe "latidos" de los agentes instalados en cada PC, guarda un registro de
// eventos, evalúa horarios permitidos y manda notificaciones (Telegram / ntfy).
// Sin dependencias: Node 18+.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DIR = __dirname;
const CONFIG_PATH = process.env.MONITOR_CONFIG || path.join(DIR, 'config.json');
const DATA_DIR = path.join(DIR, 'datos');
const STATE_PATH = path.join(DATA_DIR, 'estado.json');
const EVENTS_PATH = path.join(DATA_DIR, 'eventos.jsonl');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`No existe ${CONFIG_PATH}. Copiá config.ejemplo.json a config.json y editalo.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
config.segundosSinSenal ??= 180;
config.minutosRecordatorio ??= 30;
config.programas ??= [];
config.accesoRemoto ??= [];
config.horarios ??= [];
config.equipos ??= {};
config.dispositivos ??= [];
config.notificar ??= [];
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Estado ----------

// machines[id] = { id, alias, online, lastSeen, bootTime, user, programas: [], fueraDeHorario, ultimoAvisoFuera }
// devices[nombre] = { nombre, host, pc, online (true/false/null = sin datos), lastCheck, desde }
let state = { machines: {}, devices: {} };
try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
state.machines ??= {};
state.devices ??= {};

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), () => {});
  }, 500);
}

const recentEvents = [];
try {
  const lines = fs.readFileSync(EVENTS_PATH, 'utf8').trim().split('\n').slice(-500);
  for (const l of lines) if (l) recentEvents.push(JSON.parse(l));
} catch {}

const sseClients = new Set();
function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function logEvent(tipo, equipo, mensaje, extra = {}) {
  const ev = { ts: new Date().toISOString(), tipo, equipo, mensaje, ...extra };
  recentEvents.push(ev);
  if (recentEvents.length > 500) recentEvents.shift();
  fs.appendFile(EVENTS_PATH, JSON.stringify(ev) + '\n', () => {});
  console.log(`[${ev.ts}] ${tipo} ${equipo ?? ''} ${mensaje}`);
  broadcast('evento', ev);
  if (config.notificar.includes(tipo)) notify(ev);
  return ev;
}

// ---------- Notificaciones ----------

const ICONOS = {
  encendido: '🟢', apagado: '⚪', sin_senal: '🟠', programa_abierto: '▶️',
  programa_cerrado: '⏹️', fuera_de_horario: '🚨', dispositivo: '🔌',
  remoto_conectado: '🖥️', remoto_desconectado: '🖥️', monitor_detenido: '⏸️', monitor_reanudado: '▶️',
};

async function notify(ev) {
  const text = `${ICONOS[ev.tipo] || 'ℹ️'} ${ev.mensaje}`;
  const tg = config.telegram || {};
  if (tg.botToken && tg.chatId) {
    fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chatId, text }),
    }).catch(e => console.error('Telegram:', e.message));
  }
  const nt = config.ntfy || {};
  if (nt.tema) {
    fetch(`${(nt.servidor || 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(nt.tema)}`, {
      method: 'POST',
      headers: {
        Title: 'Monitor de Técnica',
        Priority: ev.tipo === 'fuera_de_horario' ? 'high' : 'default',
      },
      body: text,
    }).catch(e => console.error('ntfy:', e.message));
  }
}

// ---------- Horarios ----------

const DIAS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];

function localNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.zonaHoraria || undefined,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dia, minutos: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function horariosDe(id) {
  return config.equipos[id]?.horarios || config.horarios;
}

// Devuelve el horario activo o null. Soporta rangos que cruzan la medianoche.
function horarioActivo(id) {
  const { dia, minutos } = localNow();
  for (const h of horariosDe(id)) {
    const dias = h.dias.map(d => DIAS.indexOf(d.toLowerCase().slice(0, 3)));
    const desde = toMin(h.desde), hasta = toMin(h.hasta);
    if (desde <= hasta) {
      if (dias.includes(dia) && minutos >= desde && minutos < hasta) return h;
    } else if ((dias.includes(dia) && minutos >= desde) ||
               (dias.includes((dia + 6) % 7) && minutos < hasta)) {
      return h;
    }
  }
  return null;
}

// ---------- Latidos de los agentes ----------

// Sólo acepta texto (o el {value} con que PowerShell 5.1 serializa a veces un string).
function texto(v, max = 128) {
  if (v && typeof v === 'object' && typeof v.value === 'string') v = v.value;
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function aliasDe(id) { return config.equipos[id]?.alias || id; }

function coincidencias(lista, procesos) {
  const set = new Set(procesos.map(p => String(p).toLowerCase().replace(/\.exe$/, '')));
  return lista
    .filter(p => p.procesos.some(n => set.has(n.toLowerCase().replace(/\.exe$/, ''))))
    .map(p => p.nombre);
}

// Conexiones remotas: las que informa el agente (RDP, con IP) + programas de
// acceso remoto que sólo tienen un proceso abierto mientras hay una sesión.
function conexionesRemotas(body, procesos) {
  const lista = (Array.isArray(body.remoto) ? body.remoto : [])
    .map(r => texto(r?.tipo) ? `${texto(r.tipo)}${texto(r.desde) ? ` desde ${texto(r.desde)}` : ''}` : null)
    .filter(Boolean);
  return [...new Set([...lista, ...coincidencias(config.accesoRemoto, procesos)])];
}

// Cierra todo lo que estaba abierto cuando la PC deja de informar.
function limpiar(m) {
  m.programas = [];
  m.remotos = [];
  m.fueraDeHorario = false;
}

function handleHeartbeat(body) {
  const id = texto(body.equipo, 64).trim();
  if (!id) return { status: 400, body: { error: 'falta equipo' } };
  const nombre = aliasDe(id);
  const m = state.machines[id] ??= { id, programas: [], online: false };
  m.alias = nombre;
  const estabaOnline = m.online;

  if (body.evento === 'apagando') {
    m.online = false;
    m.lastSeen = new Date().toISOString();
    const abiertos = m.programas.length ? ` (programas abiertos: ${m.programas.join(', ')})` : '';
    logEvent('apagado', id, `${nombre} se está apagando${abiertos}`);
    limpiar(m);
    m.detenido = null;
    sinDatos(id);
    saveState();
    broadcast('estado', publicState());
    return { status: 200, body: { ok: true } };
  }

  if (body.evento === 'detenido') {
    const quien = texto(body.usuario, 64);
    m.online = false;
    m.lastSeen = new Date().toISOString();
    m.detenido = { por: quien || null, ts: m.lastSeen };
    logEvent('monitor_detenido', id,
      `En ${nombre} cerraron el monitor${quien ? ` (usuario ${quien})` : ''}. No se va a ver qué pasa en esa PC hasta que se reinicie o vuelvan a iniciar sesión.`);
    limpiar(m);
    sinDatos(id);
    saveState();
    broadcast('estado', publicState());
    return { status: 200, body: { ok: true } };
  }

  const inicio = texto(body.inicioSistema, 40);
  const inicioValido = inicio && !isNaN(Date.parse(inicio)) ? inicio : '';
  const reinicio = inicioValido && inicioValido !== m.bootTime;
  const estabaDetenido = !!m.detenido;
  m.online = true;
  m.detenido = null;
  m.lastSeen = new Date().toISOString();
  m.bootTime = inicioValido || m.bootTime;
  m.usuario = texto(body.usuario) || m.usuario;
  m.elevado = typeof body.elevado === 'boolean' ? body.elevado : null;

  if (estabaDetenido && !reinicio) {
    logEvent('monitor_reanudado', id, `El monitor de ${nombre} volvió a funcionar`);
  } else if (!estabaOnline) {
    const desde = inicioValido
      ? ` (encendida a las ${new Date(inicioValido).toLocaleTimeString('es-AR', { timeZone: config.zonaHoraria, hour: '2-digit', minute: '2-digit' })})`
      : '';
    logEvent('encendido', id, `${nombre} está encendida${desde}`);
  }

  const procesos = (Array.isArray(body.procesos) ? body.procesos : []).map(p => texto(p)).filter(Boolean);
  const ahora = coincidencias(config.programas, procesos);
  for (const p of ahora) if (!m.programas.includes(p)) logEvent('programa_abierto', id, `${p} se abrió en ${nombre}`, { programa: p });
  for (const p of m.programas) if (!ahora.includes(p)) logEvent('programa_cerrado', id, `${p} se cerró en ${nombre}`, { programa: p });
  m.programas = ahora;

  const remotos = conexionesRemotas(body, procesos);
  m.remotos ??= [];
  const idAnyDesk = /^\d{9,10}$/.test(body.anydeskId) ? body.anydeskId : null;
  for (const r of remotos) {
    if (m.remotos.includes(r)) continue;
    const quien = idAnyDesk && /anydesk/i.test(r) ? ` (último ID de AnyDesk registrado: ${idAnyDesk})` : '';
    logEvent('remoto_conectado', id, `Se conectaron por remoto a ${nombre}: ${r}${quien}`, { remoto: r });
  }
  for (const r of m.remotos) if (!remotos.includes(r)) logEvent('remoto_desconectado', id, `Terminó la conexión remota a ${nombre}: ${r}`, { remoto: r });
  m.remotos = remotos;

  // Resultado del ping que hizo esta PC a los dispositivos que tiene asignados.
  const asignados = dispositivosDe(id);
  for (const r of Array.isArray(body.dispositivos) ? body.dispositivos : []) {
    const d = asignados.find(x => x.nombre === texto(r?.nombre));
    if (d && typeof r.online === 'boolean') actualizarDispositivo(d, r.online);
  }

  evaluarHorario(m);
  saveState();
  broadcast('estado', publicState());
  // En la respuesta va la lista de dispositivos que esta PC tiene que pinguear.
  return { status: 200, body: { ok: true, ping: asignados.map(({ nombre, host }) => ({ nombre, host })) } };
}

function evaluarHorario(m) {
  if (!m.online) { m.fueraDeHorario = false; return; }
  const activo = horarioActivo(m.id);
  if (activo) { m.fueraDeHorario = false; m.horarioActual = activo.nombre; return; }
  m.horarioActual = null;
  const ahora = Date.now();
  const ultimo = m.ultimoAvisoFuera ? Date.parse(m.ultimoAvisoFuera) : 0;
  const yaAvisado = m.fueraDeHorario && ahora - ultimo < config.minutosRecordatorio * 60000;
  m.fueraDeHorario = true;
  if (yaAvisado) return;
  m.ultimoAvisoFuera = new Date(ahora).toISOString();
  const progs = m.programas.length ? ` con ${m.programas.join(', ')} abierto` : '';
  const rem = m.remotos?.length ? ` y conexión remota (${m.remotos.join(', ')})` : '';
  logEvent('fuera_de_horario', m.id, `${m.alias} está encendida fuera de horario${progs}${rem}`);
}

// ---------- Chequeos periódicos ----------

function chequearSinSenal() {
  const limite = Date.now() - config.segundosSinSenal * 1000;
  let cambio = false;
  for (const m of Object.values(state.machines)) {
    if (m.online && Date.parse(m.lastSeen) < limite) {
      m.online = false;
      const abiertos = m.programas.length ? ` Tenía abierto: ${m.programas.join(', ')}.` : '';
      logEvent('sin_senal', m.id, `${m.alias} dejó de responder (apagado brusco, corte de luz o sin red).${abiertos}`);
      limpiar(m);
      sinDatos(m.id);
      cambio = true;
    } else if (m.online) {
      const antes = m.fueraDeHorario;
      evaluarHorario(m);
      if (antes !== m.fueraDeHorario) cambio = true;
    }
  }
  if (cambio) { saveState(); broadcast('estado', publicState()); }
}

function ping(host) {
  const args = process.platform === 'win32' ? ['-n', '1', '-w', '2000', host] : ['-c', '1', '-W', '2', host];
  return new Promise(resolve => execFile('ping', args, { timeout: 5000 }, err => resolve(!err)));
}

// Los dispositivos con "pc" los pinguea esa PC (están en la red de la iglesia y el
// servidor puede estar en una VPS); los demás los pinguea el servidor.
function dispositivosDe(id) { return config.dispositivos.filter(d => d.pc === id); }

function actualizarDispositivo(d, online) {
  const prev = state.devices[d.nombre];
  const ahora = new Date().toISOString();
  state.devices[d.nombre] = {
    nombre: d.nombre, host: d.host, pc: d.pc ? aliasDe(d.pc) : null, online, lastCheck: ahora,
    desde: prev && prev.online === online ? prev.desde : ahora,
  };
  // "Sin datos" (null) no es ni encendido ni apagado: no genera avisos.
  if (typeof prev?.online === 'boolean' && typeof online === 'boolean' && prev.online !== online) {
    logEvent('dispositivo', d.nombre, `${d.nombre} ${online ? 'se encendió / volvió a la red' : 'se apagó / salió de la red'}`);
  }
  if (online === true && prev?.online !== true && !horarioActivo(d.nombre)) {
    logEvent('fuera_de_horario', d.nombre, `${d.nombre} está encendido fuera de horario`);
  }
}

// La PC que pinguea se apagó o dejó de informar: no se sabe el estado de sus dispositivos.
function sinDatos(id) {
  for (const d of dispositivosDe(id)) actualizarDispositivo(d, null);
}

async function chequearDispositivos() {
  for (const d of config.dispositivos.filter(d => !d.pc)) actualizarDispositivo(d, await ping(d.host));
  saveState();
  broadcast('estado', publicState());
}

for (const d of config.dispositivos) {
  if (d.pc && !state.devices[d.nombre]) actualizarDispositivo(d, null);
}

setInterval(chequearSinSenal, 15000);
if (config.dispositivos.some(d => !d.pc)) { chequearDispositivos(); setInterval(chequearDispositivos, 60000); }

// ---------- HTTP ----------

function publicState() {
  return {
    ahora: new Date().toISOString(),
    machines: Object.values(state.machines).map(m => ({ ...m, horarios: horariosDe(m.id) })),
    devices: config.dispositivos.map(d => state.devices[d.nombre]).filter(Boolean),
    horarios: config.horarios,
    programas: config.programas.map(p => p.nombre),
  };
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function dashboardAuth(req, res) {
  if (!config.claveDashboard) return true;
  const h = req.headers.authorization || '';
  const pass = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString().split(':').slice(1).join(':');
  if (pass === config.claveDashboard) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Monitor de Tecnica"' });
  res.end('Clave requerida');
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST' && url.pathname === '/api/latido') {
    if (req.headers['x-token'] !== config.token) return send(res, 401, { error: 'token inválido' });
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON inválido' }); }
      if (!body || typeof body !== 'object') return send(res, 400, { error: 'JSON inválido' });
      try {
        const r = handleHeartbeat(body);
        send(res, r.status, r.body);
      } catch (e) {
        console.error('Error procesando latido:', e);
        send(res, 500, { error: 'error interno' });
      }
    });
    return;
  }

  if (!dashboardAuth(req, res)) return;

  if (url.pathname === '/api/estado') return send(res, 200, publicState());
  if (url.pathname === '/api/eventos') {
    const n = Math.min(Number(url.searchParams.get('n')) || 200, 500);
    return send(res, 200, recentEvents.slice(-n).reverse());
  }
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: estado\ndata: ${JSON.stringify(publicState())}\n\n`);
    sseClients.add(res);
    const keep = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(keep); sseClients.delete(res); });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(DIR, 'public', 'index.html')).pipe(res);
  }
  send(res, 404, { error: 'no encontrado' });
});

server.listen(config.puerto || 8080, () => {
  console.log(`Monitor de Técnica escuchando en http://localhost:${config.puerto || 8080}`);
});

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
config.horarios ??= [];
config.equipos ??= {};
config.dispositivos ??= [];
config.notificar ??= [];
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Estado ----------

// machines[id] = { id, alias, online, lastSeen, bootTime, user, programas: [], fueraDeHorario, ultimoAvisoFuera }
// devices[nombre] = { nombre, host, online, lastCheck }
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

function aliasDe(id) { return config.equipos[id]?.alias || id; }

function programasAbiertos(procesos) {
  const set = new Set(procesos.map(p => String(p).toLowerCase().replace(/\.exe$/, '')));
  return config.programas
    .filter(p => p.procesos.some(n => set.has(n.toLowerCase().replace(/\.exe$/, ''))))
    .map(p => p.nombre);
}

function handleHeartbeat(body) {
  const id = String(body.equipo || '').trim().slice(0, 64);
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
    m.programas = [];
    m.fueraDeHorario = false;
    saveState();
    broadcast('estado', publicState());
    return { status: 200, body: { ok: true } };
  }

  m.online = true;
  m.lastSeen = new Date().toISOString();
  m.bootTime = body.inicioSistema || m.bootTime;
  m.usuario = body.usuario || m.usuario;

  if (!estabaOnline) {
    const desde = body.inicioSistema
      ? ` (encendida a las ${new Date(body.inicioSistema).toLocaleTimeString('es-AR', { timeZone: config.zonaHoraria, hour: '2-digit', minute: '2-digit' })})`
      : '';
    logEvent('encendido', id, `${nombre} está encendida${desde}`);
  }

  const ahora = programasAbiertos(Array.isArray(body.procesos) ? body.procesos : []);
  for (const p of ahora) if (!m.programas.includes(p)) logEvent('programa_abierto', id, `${p} se abrió en ${nombre}`, { programa: p });
  for (const p of m.programas) if (!ahora.includes(p)) logEvent('programa_cerrado', id, `${p} se cerró en ${nombre}`, { programa: p });
  m.programas = ahora;

  evaluarHorario(m);
  saveState();
  broadcast('estado', publicState());
  return { status: 200, body: { ok: true } };
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
  logEvent('fuera_de_horario', m.id, `${m.alias} está encendida fuera de horario${progs}`);
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
      m.programas = [];
      m.fueraDeHorario = false;
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

async function chequearDispositivos() {
  for (const d of config.dispositivos) {
    const ok = await ping(d.host);
    const prev = state.devices[d.nombre];
    state.devices[d.nombre] = { nombre: d.nombre, host: d.host, online: ok, lastCheck: new Date().toISOString(),
      desde: prev && prev.online === ok ? prev.desde : new Date().toISOString() };
    if (prev && prev.online !== ok) {
      logEvent('dispositivo', d.nombre, `${d.nombre} ${ok ? 'se encendió / volvió a la red' : 'se apagó / salió de la red'}`);
      evaluarDispositivoFuera(d.nombre, ok);
    }
  }
  saveState();
  broadcast('estado', publicState());
}

function evaluarDispositivoFuera(nombre, online) {
  if (online && !horarioActivo(nombre)) {
    logEvent('fuera_de_horario', nombre, `${nombre} está encendido fuera de horario`);
  }
}

setInterval(chequearSinSenal, 15000);
if (config.dispositivos.length) { chequearDispositivos(); setInterval(chequearDispositivos, 60000); }

// ---------- HTTP ----------

function publicState() {
  return {
    ahora: new Date().toISOString(),
    machines: Object.values(state.machines).map(m => ({ ...m, horarios: horariosDe(m.id) })),
    devices: Object.values(state.devices),
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
      const r = handleHeartbeat(body);
      send(res, r.status, r.body);
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

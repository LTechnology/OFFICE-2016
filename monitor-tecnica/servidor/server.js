// Monitor de Técnica: servidor central.
// Recibe "latidos" de los agentes instalados en cada PC, guarda un registro de
// eventos, evalúa horarios permitidos y manda notificaciones (push a la web app,
// Telegram, ntfy). Node 18+; única dependencia: web-push (opcional).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const DIR = __dirname;
const CONFIG_PATH = process.env.MONITOR_CONFIG || path.join(DIR, 'config.json');
const DATA_DIR = path.join(DIR, 'datos');
const STATE_PATH = path.join(DATA_DIR, 'estado.json');
const EVENTS_PATH = path.join(DATA_DIR, 'eventos.jsonl');
const VAPID_PATH = path.join(DATA_DIR, 'vapid.json');
const SUBS_PATH = path.join(DATA_DIR, 'suscripciones.json');
const SECRET_PATH = path.join(DATA_DIR, 'secreto');

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
  const urgente = ev.tipo === 'fuera_de_horario' || ev.tipo === 'remoto_conectado' || ev.tipo === 'monitor_detenido';
  for (const sub of [...suscripciones]) {
    enviarPush(sub, {
      title: 'Monitor de Técnica', body: text,
      // Los recordatorios de "fuera de horario" de un mismo equipo se reemplazan en vez de acumularse.
      tag: ev.tipo === 'fuera_de_horario' ? `fuera-${ev.equipo}` : undefined,
    }, urgente ? 'high' : 'normal').catch(() => {});
  }
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

// ---------- Notificaciones push (web app instalada en el celular) ----------

let webpush = null;
try { webpush = require('web-push'); } catch {
  console.warn('Falta el paquete "web-push" (ejecutá npm install): las notificaciones push quedan desactivadas.');
}
let vapid = null;
let suscripciones = [];
if (webpush) {
  try { vapid = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8')); } catch {
    vapid = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_PATH, JSON.stringify(vapid), { mode: 0o600 });
  }
  // Apple rechaza los envíos si el contacto no es un mailto: o https: válido.
  webpush.setVapidDetails(config.contactoPush || 'mailto:tecnica@example.com', vapid.publicKey, vapid.privateKey);
  try { suscripciones = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8')); } catch {}
}

function guardarSuscripciones() {
  fs.writeFile(SUBS_PATH, JSON.stringify(suscripciones, null, 2), { mode: 0o600 }, () => {});
}

function enviarPush(sub, payload, urgency = 'normal') {
  if (!webpush) return Promise.reject(new Error('push desactivado'));
  return webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 3600, urgency })
    .catch(e => {
      // 404/410: el celular borró la suscripción (desinstaló la app o quitó el permiso).
      if (e.statusCode === 404 || e.statusCode === 410) {
        suscripciones = suscripciones.filter(x => x.endpoint !== sub.endpoint);
        guardarSuscripciones();
      } else {
        console.error('Push:', e.statusCode || '', e.body || e.message);
      }
      throw e;
    });
}

// Sólo servicios de push reales (evita que el servidor haga pedidos a cualquier URL).
const SERVICIOS_PUSH = ['.googleapis.com', '.push.apple.com', '.mozilla.com', '.notify.windows.com'];
function suscripcionValida(b) {
  try {
    const u = new URL(b.endpoint);
    return u.protocol === 'https:' && SERVICIOS_PUSH.some(d => u.hostname.endsWith(d)) &&
      typeof b.keys?.p256dh === 'string' && typeof b.keys?.auth === 'string';
  } catch { return false; }
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

// Lista completa de procesos de cada PC, sólo en memoria, para "Ver procesos" en el panel.
const todosLosProcesos = {};

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
  todosLosProcesos[id] = [...new Set(procesos)].sort((a, b) => a.localeCompare(b));
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
  // Primero las PCs del config (en ese orden, aunque todavía no se hayan conectado), después cualquier otra.
  const ids = [...new Set([...Object.keys(config.equipos), ...Object.keys(state.machines)])];
  return {
    ahora: new Date().toISOString(),
    zonaHoraria: config.zonaHoraria || null,
    machines: ids.map(id => {
      const m = state.machines[id] || { id, alias: aliasDe(id), online: false, nuncaConectada: true, programas: [], remotos: [] };
      return {
        ...m,
        alias: aliasDe(id),
        horarios: horariosDe(id),
        // Programas que se muestran en la tarjeta de esta PC (abiertos o cerrados).
        vigilar: config.equipos[id]?.programas || config.programas.map(p => p.nombre),
        dispositivos: dispositivosDe(id).map(d => d.nombre),
      };
    }),
    devices: config.dispositivos.map(d => state.devices[d.nombre] && { ...state.devices[d.nombre], tipo: d.tipo || 'equipo' }).filter(Boolean),
    horarios: config.horarios,
    programas: config.programas.map(p => p.nombre),
  };
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- Sesión del panel ----------
// Login con contraseña y cookie (la autenticación básica del navegador no funciona
// bien en las web apps instaladas en iPhone).

let secreto;
try { secreto = fs.readFileSync(SECRET_PATH); } catch {
  secreto = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_PATH, secreto, { mode: 0o600 });
}
const COOKIE = 'mt_sesion';
const firma = v => crypto.createHmac('sha256', secreto).update(v).digest('base64url');
// La firma incluye la clave: si se cambia la clave, se cierran todas las sesiones.
const valorSesion = vence => `${vence}.${firma(`${vence}:${config.claveDashboard}`)}`;

function sesionValida(req) {
  if (!config.claveDashboard) return true;
  const c = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
  if (!c) return false;
  const [vence] = c.slice(COOKIE.length + 1).split('.');
  if (!(Number(vence) > Date.now())) return false;
  const a = Buffer.from(c.slice(COOKIE.length + 1)), b = Buffer.from(valorSesion(vence));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieSesion(req, valor, maxAge) {
  const segura = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${segura}`;
}

function claveCorrecta(clave) {
  const a = crypto.createHash('sha256').update(String(clave)).digest();
  const b = crypto.createHash('sha256').update(String(config.claveDashboard)).digest();
  return crypto.timingSafeEqual(a, b);
}

function leerCuerpo(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > max) { reject(new Error('muy grande')); req.destroy(); } });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function leerJSON(req) {
  try { const b = JSON.parse(await leerCuerpo(req)); return b && typeof b === 'object' ? b : null; } catch { return null; }
}

// Archivos públicos: la web app necesita poder pedirlos sin sesión (manifest e íconos).
const PUBLICOS = {
  '/login': ['login.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icono-192.png': ['icono-192.png', 'image/png'],
  '/icono-512.png': ['icono-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

function servirArchivo(res, archivo, tipo) {
  res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(DIR, 'public', archivo)).pipe(res);
}

async function manejar(req, res) {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST' && url.pathname === '/api/latido') {
    if (req.headers['x-token'] !== config.token) return send(res, 401, { error: 'token inválido' });
    const body = await leerJSON(req);
    if (!body) return send(res, 400, { error: 'JSON inválido' });
    const r = handleHeartbeat(body);
    return send(res, r.status, r.body);
  }

  if (req.method === 'POST' && url.pathname === '/login') {
    const clave = new URLSearchParams(await leerCuerpo(req, 10000)).get('clave') || '';
    if (!config.claveDashboard || claveCorrecta(clave)) {
      const vence = Date.now() + 365 * 86400000;
      res.writeHead(303, { Location: '/', 'Set-Cookie': cookieSesion(req, valorSesion(vence), 365 * 86400) });
      return res.end();
    }
    await new Promise(r => setTimeout(r, 1000)); // frena intentos de adivinar la clave
    res.writeHead(303, { Location: '/login?error=1' });
    return res.end();
  }
  if (url.pathname === '/logout') {
    res.writeHead(303, { Location: '/login', 'Set-Cookie': cookieSesion(req, '', 0) });
    return res.end();
  }
  if (PUBLICOS[url.pathname]) return servirArchivo(res, ...PUBLICOS[url.pathname]);

  if (!sesionValida(req)) {
    if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'sesión requerida' });
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  if (url.pathname === '/api/estado') return send(res, 200, publicState());
  if (url.pathname === '/api/eventos') {
    const n = Math.min(Number(url.searchParams.get('n')) || 200, 500);
    return send(res, 200, recentEvents.slice(-n).reverse());
  }
  if (url.pathname === '/api/procesos') {
    return send(res, 200, todosLosProcesos[url.searchParams.get('equipo')] || []);
  }
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: estado\ndata: ${JSON.stringify(publicState())}\n\n`);
    sseClients.add(res);
    const keep = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(keep); sseClients.delete(res); });
    return;
  }

  if (url.pathname === '/api/push/config') {
    return send(res, 200, { disponible: !!vapid, clave: vapid?.publicKey || null });
  }
  if (req.method === 'POST' && url.pathname === '/api/push/suscribir') {
    const b = await leerJSON(req);
    if (!vapid) return send(res, 503, { error: 'push desactivado en el servidor' });
    if (!b || !suscripcionValida(b)) return send(res, 400, { error: 'suscripción inválida' });
    suscripciones = suscripciones.filter(x => x.endpoint !== b.endpoint);
    suscripciones.push({ endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth },
      dispositivo: texto(b.dispositivo, 80), creada: new Date().toISOString() });
    guardarSuscripciones();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/push/desuscribir') {
    const b = await leerJSON(req);
    suscripciones = suscripciones.filter(x => x.endpoint !== b?.endpoint);
    guardarSuscripciones();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/push/probar') {
    const b = await leerJSON(req);
    const sub = suscripciones.find(x => x.endpoint === b?.endpoint);
    if (!sub) return send(res, 404, { error: 'este dispositivo no está suscripto' });
    try {
      await enviarPush(sub, { title: 'Monitor de Técnica', body: '✅ Las notificaciones funcionan en este dispositivo.' }, 'high');
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 502, { error: `el servicio de push respondió ${e.statusCode || e.message}` });
    }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') return servirArchivo(res, 'index.html', 'text/html; charset=utf-8');
  send(res, 404, { error: 'no encontrado' });
}

const server = http.createServer((req, res) => {
  manejar(req, res).catch(e => {
    console.error('Error en', req.method, req.url, e);
    if (!res.headersSent) send(res, 500, { error: 'error interno' });
    else res.end();
  });
});

server.listen(config.puerto || 8080, config.host || undefined, () => {
  console.log(`Monitor de Técnica escuchando en http://localhost:${config.puerto || 8080}`);
});

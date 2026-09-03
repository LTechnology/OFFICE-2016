// Paso 1: captura del payload JSON crudo que alimenta la tabla de vuelos
// de aeropuertosargentina.com, interceptando las respuestas XHR/fetch.
// Uso: node scripts/capturar.js <idarpt> <alias> <fecha DD-MM-YYYY> [movtp]
//   ej: node scripts/capturar.js "Ezeiza, EZE" eze 04-09-2026 arribos
// Guarda: data/raw/{alias}_{fecha}.json  (payload elegido)
//         data/raw/{alias}_{fecha}.responses.json (índice de todas las
//         respuestas JSON capturadas, para inspección del schema)

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const [idarpt, alias, fecha, movtp = 'arribos'] = process.argv.slice(2);
if (!idarpt || !alias || !fecha) {
  console.error('Uso: node scripts/capturar.js <idarpt> <alias> <fecha DD-MM-YYYY> [movtp]');
  process.exit(2);
}

const RAW_DIR = path.join(__dirname, '..', 'data', 'raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

// Heurística para decidir si un JSON "parece" el payload de vuelos:
// buscamos arrays de objetos cuyas claves mencionen vuelo/flight/airline/etc.
const FLIGHT_KEY_RE = /(flight|vuelo|airline|aerolinea|iata|origin|origen|destino|destination|std|sta|eta|etd|hora|arpt|mov)/i;

function findFlightArrays(node, trail = '$', found = []) {
  if (Array.isArray(node)) {
    if (node.length > 0 && typeof node[0] === 'object' && node[0] !== null) {
      const keys = Object.keys(node[0]);
      const hits = keys.filter((k) => FLIGHT_KEY_RE.test(k)).length;
      if (hits >= 2) found.push({ trail, length: node.length, sampleKeys: keys });
    }
    node.forEach((v, i) => { if (v && typeof v === 'object') findFlightArrays(v, `${trail}[${i}]`, found); });
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') findFlightArrays(v, `${trail}.${k}`, found);
    }
  }
  return found;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    // Chromium preinstalado del entorno; la versión bundled de playwright no está descargada.
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    // La salida HTTPS del entorno pasa por un proxy local; Chromium no lee
    // HTTPS_PROXY del entorno, hay que pasarlo explícito.
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    // El egress del entorno resetea el ClientHello TLS1.3 (con keyshare
    // post-cuántico) de Chromium; capeado a TLS1.2 funciona. La verificación
    // de certificados sigue activa (CA del proxy importada en NSS).
    args: ['--ssl-version-max=tls1.2'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'es-AR',
  });
  const page = await context.newPage();

  const captured = []; // toda respuesta JSON, con metadatos

  page.on('response', async (response) => {
    const url = response.url();
    const ct = (response.headers()['content-type'] || '').toLowerCase();
    const rt = response.request().resourceType();
    if (!(rt === 'xhr' || rt === 'fetch')) return;
    if (!ct.includes('json') && !url.includes('json')) return;
    try {
      const body = await response.json();
      const flightArrays = findFlightArrays(body);
      captured.push({ url, status: response.status(), contentType: ct, flightArrays, body });
      console.error(`[xhr] ${response.status()} ${url.slice(0, 140)} arrays_de_vuelos=${flightArrays.length}`);
    } catch (_) {
      /* no era JSON parseable */
    }
  });

  const target = `https://www.aeropuertosargentina.com/es/vuelos?movtp=${encodeURIComponent(
    movtp
  )}&idarpt=${encodeURIComponent(idarpt)}&fecha=${fecha}`;
  console.error(`[nav] ${target}`);

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Dar tiempo a que la SPA dispare sus XHR (y a algún retry interno).
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(5000);

  const withFlights = captured.filter((c) => c.flightArrays.length > 0);

  const base = path.join(RAW_DIR, `${alias}_${fecha}`);
  // Índice de todas las respuestas (sin cuerpos gigantes duplicados: solo urls + arrays detectados)
  fs.writeFileSync(
    `${base}.responses.json`,
    JSON.stringify(
      captured.map(({ url, status, contentType, flightArrays }) => ({ url, status, contentType, flightArrays })),
      null,
      2
    )
  );

  if (withFlights.length > 0) {
    // Elegimos la respuesta con el array de vuelos más grande.
    withFlights.sort(
      (a, b) =>
        Math.max(...b.flightArrays.map((f) => f.length)) - Math.max(...a.flightArrays.map((f) => f.length))
    );
    const chosen = withFlights[0];
    fs.writeFileSync(`${base}.json`, JSON.stringify({ _capturedFrom: chosen.url, payload: chosen.body }, null, 2));
    console.error(`[ok] payload XHR guardado en ${base}.json (desde ${chosen.url.slice(0, 120)})`);
  } else {
    // Fallback: parsear el DOM tras esperar las filas.
    console.error('[warn] ninguna XHR con vuelos; fallback a DOM');
    await page
      .waitForSelector('table tbody tr, [class*="flight" i], [class*="vuelo" i]', { timeout: 30000 })
      .catch(() => {});
    const dom = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td,th')).map((td) => td.innerText.trim())
      );
      const cards = Array.from(document.querySelectorAll('[class*="flight" i], [class*="vuelo" i]'))
        .slice(0, 400)
        .map((el) => ({ cls: el.className && String(el.className).slice(0, 80), text: el.innerText.trim().slice(0, 300) }));
      return { title: document.title, rows, cards, bodySnippet: document.body.innerText.slice(0, 2000) };
    });
    fs.writeFileSync(`${base}.json`, JSON.stringify({ _capturedFrom: 'DOM_FALLBACK', payload: dom }, null, 2));
    console.error(`[ok] fallback DOM guardado en ${base}.json (${dom.rows.length} filas de tabla)`);
  }

  await browser.close();
})();

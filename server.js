import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import QRCode from 'qrcode';
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Servir archivos estáticos (logo, etc.)
app.use('/static', express.static(path.join(__dirname, 'public')));


// 👉 Normaliza rutas: "//asistencia" -> "/asistencia"
// app.use((req, _res, next) => { req.url = req.url.replace(/\/{2,}/g, '/'); next(); });
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ===== ENV =====
const PORT = process.env.PORT || 8080;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Asistentes';
const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL;
const SERVICE_ACCOUNT_KEY = process.env.SERVICE_ACCOUNT_KEY; // con \n escapados
const RAW_BASE_URL = (process.env.BASE_URL || '').trim();    // SIN "/" al final

if (!SHEET_ID || !SERVICE_ACCOUNT_EMAIL || !SERVICE_ACCOUNT_KEY) {
  console.error('Faltan envs: SHEET_ID, SERVICE_ACCOUNT_EMAIL, SERVICE_ACCOUNT_KEY');
  process.exit(1);
}

// Base saneada; si no viene, la arma desde la request
const getBase = (req) =>
  (RAW_BASE_URL ? RAW_BASE_URL.replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`);

// ===== Google Sheets =====
const auth = new google.auth.JWT({
  email: SERVICE_ACCOUNT_EMAIL,
  key: SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

// ===== Helpers =====
const headersLower = (arr = []) => arr.map(x => (x || '').toString().trim().toLowerCase());
const col = i => String.fromCharCode(65 + i); // 0->A,1->B,...

async function readAll() {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:C` // A:ID, B:Nombre, C:Asistencia
  });
  return data.values || [];
}

// --- si ya tienes parseSheet, conserva el tuyo; si no, usa este ---
function parseSheet(values) {
  if (!values || values.length === 0)
    return { rows: [], hasHeader: false, headers: ['id','nombre','asistencia'] };
  const hdr = (values[0] || []).map(x => (x||'').toString().trim().toLowerCase());
  const looksLikeHeader = hdr.includes('id') || hdr.includes('nombre') || hdr.includes('asistencia');
  if (looksLikeHeader) return { rows: values.slice(1), hasHeader: true, headers: hdr };
  return { rows: values, hasHeader: false, headers: ['id','nombre','asistencia'] };
}

// Encuentra {rowIndex, id, nombre, asistencia}
async function getParticipantById(id) {
  const values = await readAll();
  const { rows, hasHeader, headers } = parseSheet(values);
  const idxId  = hasHeader ? (headers.indexOf('id') !== -1 ? headers.indexOf('id') : 0) : 0;
  const idxNom = hasHeader
    ? (['nombre','nombres','participante','name','nombre y apellido','fullname','full name']
        .map(k => headers.indexOf(k)).find(i => i !== -1) ?? 1)
    : 1;
  const idxAsis = hasHeader ? (headers.indexOf('asistencia') !== -1 ? headers.indexOf('asistencia') : 2) : 2;

  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][idxId] || '').toString().trim() === id.toString().trim()) {
      const rowIndex = (hasHeader ? 2 : 1) + i; // 1-based
      return {
        rowIndex,
        headers: hasHeader ? headers : ['id','nombre','asistencia'],
        id: rows[i][idxId] ?? '',
        nombre: rows[i][idxNom] ?? '',
        asistencia: rows[i][idxAsis] ?? '',
        hasHeader,
        allValues: values
      };
    }
  }
  return { rowIndex: -1, headers: hasHeader ? headers : ['id','nombre','asistencia'] };
}


async function findRowById(id) {
  const values = await readAll();
  if (values.length < 2) return { rowIndex: -1, headers: [], values };
  const headers = headersLower(values[0]); // id | nombre | asistencia
  const idxId = headers.indexOf('id');
  if (idxId === -1) throw new Error('Falta columna "ID" en la hoja');
  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if ((values[i][idxId] || '').toString().trim() === id.toString().trim()) {
      rowIndex = i + 1; // 1-based
      break;
    }
  }
  return { rowIndex, headers, values };
}

async function setAsistenciaSI(rowIndex, headers) {
  const idxAsis = headers.indexOf('asistencia'); // C
  if (idxAsis === -1) throw new Error('Falta columna "Asistencia"');
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!${col(idxAsis)}${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['SI']] }
  });
}

// ===== API =====

// Lista de participantes (con nombres)
app.get('/api/participants', async (_req, res) => {
  try {
    const values = await readAll();
    if (values.length < 2) return res.json({ participants: [] });
    const headers = headersLower(values[0]);       // ["id","nombre","asistencia"]
    const rows = values.slice(1).map(r => {
      const o = {};
      headers.forEach((h, i) => (o[h] = r[i] ?? ''));
      // normaliza nombres si tu hoja tiene otra cabecera
      o.id = o.id || o['id participante'] || o.codigo || '';
      o.nombre = o.nombre || o.nombres || o.name || o.participante || '';
      o.asistencia = o.asistencia || o.attendance || o['asistió'] || '';
      return o;
    });
    res.json({ participants: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo leer la hoja' });
  }
});

// PNG del QR: apunta a /attend
app.get('/qr/:id.png', async (req, res) => {
  try {
    const id = req.params.id;
    const url = `${getBase(req)}/attend?pid=${encodeURIComponent(id)}`;
    const png = await QRCode.toBuffer(url, { width: 600, margin: 1 });
    res.set('Content-Type', 'image/png').send(png);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error generando QR');
  }
});

const THEME = (process.env.THEME_COLOR || '#0b57d0').trim();
const EVENT = (process.env.EVENT_NAME || 'Mi Evento').trim();
const DATE  = (process.env.EVENT_DATE || '').trim();
const LOGO  = (process.env.EVENT_LOGO_URL || '').trim();

async function fetchLogoBuffer() {
  try {
    if (!LOGO) return null;
    const r = await fetch(LOGO);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

// HTML de vista previa (opcional)
app.get('/card/:id', async (req, res) => {
  const id = req.params.id;
  const info = await getParticipantById(id); // ← helper (punto 5)
  if (info.rowIndex === -1) return res.status(404).send('ID no encontrado');
  const nombre = (info.nombre || '').trim() || `ID ${info.id}`;
  const base = (process.env.BASE_URL?.trim() ? process.env.BASE_URL.trim().replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`);
  const url = `${base}/attend?pid=${encodeURIComponent(id)}`;
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Card ${nombre}</title>
  <style>body{font-family:system-ui;margin:0;background:#f2f4f8} .wrap{max-width:900px;margin:20px auto;padding:16px} .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px} .card{background:#fff;border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,.08);padding:24px} .title{font-weight:800;font-size:28px;margin-bottom:10px}</style></head>
  <body><div class="wrap"><div class="grid">
    <div class="card"><div class="title">${EVENT}</div><div>Participante:</div><h2>${nombre}</h2><div>ID: ${id}</div><div style="margin-top:10px;color:#666">${DATE || ''}</div></div>
    <div class="card" style="text-align:center">
      <img src="/qr/${encodeURIComponent(id)}.png" style="max-width:360px;width:100%;border-radius:12px"/>
      <div style="margin-top:10px;color:#666">Escanear para registrar asistencia</div>
      <div style="margin-top:8px;word-break:break-all;font-size:12px;color:#999">${url}</div>
    </div>
  </div></div></body></html>`);
});

// PNG final para enviar
app.get('/card/:id.png', async (req, res) => {
  try {
    const id = req.params.id;
    const info = await getParticipantById(id);
    if (info.rowIndex === -1) return res.status(404).send('ID no encontrado');
    const nombre = (info.nombre || '').trim() || `ID ${info.id}`;

    const base = (process.env.BASE_URL?.trim() ? process.env.BASE_URL.trim().replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`);
    const url = `${base}/attend?pid=${encodeURIComponent(id)}`;
    const qrPng = await QRCode.toBuffer(url, { width: 680, margin: 1 });

    const W = 1080, H = 1350, bg = '#f2f4f7';
    const svg = Buffer.from(`
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${W}" height="${H}" fill="${bg}"/>
        <rect x="60" y="60" rx="36" ry="36" width="${W-120}" height="${H-120}" fill="#ffffff"/>
        <text x="${W/2}" y="210" text-anchor="middle" font-family="Inter, system-ui" font-size="56" font-weight="800" fill="#111">${EVENT}</text>
        ${DATE ? `<text x="${W/2}" y="270" text-anchor="middle" font-family="Inter, system-ui" font-size="28" fill="#555">${DATE}</text>` : '' }
        <text x="${W/2}" y="${H-260}" text-anchor="middle" font-family="Inter, system-ui" font-size="44" font-weight="800" fill="#111">${nombre}</text>
        <text x="${W/2}" y="${H-210}" text-anchor="middle" font-family="Inter, system-ui" font-size="28" fill="#555">ID: ${id}</text>
        <rect x="${(W-360)/2}" y="${H-160}" rx="999" width="360" height="60" fill="${THEME}"/>
        <text x="${W/2}" y="${H-120}" text-anchor="middle" font-family="Inter, system-ui" font-size="26" font-weight="700" fill="#fff">Presenta este QR al ingresar</text>
      </svg>
    `);

    let img = sharp(svg);
    const logoBuf = await fetchLogoBuffer();
    if (logoBuf) {
      const logoResized = await sharp(logoBuf).resize({ width: 240, height: 120, fit: 'inside' }).png().toBuffer();
      img = img.composite([{ input: logoResized, top: 110, left: Math.round((W - 240) / 2) }]);
    }
    img = img.composite([{ input: qrPng, top: 360, left: Math.round((W - 680) / 2) }]);

    const out = await img.png().toBuffer();
    res.set('Content-Type', 'image/png').send(out);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error generando card');
  }
});


// Handler común para /attend y /asistencia (alias)
async function attendHandler(req, res) {
  try {
    const id = (req.query.pid || '').toString().trim();
    if (!id) return res.status(400).send('Falta pid');

    const info = await getParticipantById(id);
    if (info.rowIndex === -1) return res.status(404).send('ID no encontrado');

    // ¿ya estaba en SI?
    const idxAsis = (info.headers.indexOf('asistencia') !== -1) ? info.headers.indexOf('asistencia') : 2;
    const zeroBasedRow = (info.hasHeader ? info.rowIndex - 2 : info.rowIndex - 1);
    const rows = parseSheet(info.allValues).rows;
    const ya = ((rows[zeroBasedRow][idxAsis] || '').toString().toUpperCase() === 'SI');

    if (!ya) await setAsistenciaSI(info.rowIndex, info.headers);

    const nombreMostrado = (info.nombre || '').toString().trim() || `ID ${info.id}`;

    res.type('html').send(`
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Asistencia confirmada</title>
<style>
  body{font-family:system-ui;margin:0;background:#f5f7fb;color:#111}
  .wrap{max-width:680px;margin:32px auto;padding:24px}
  .card{background:#fff;border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,.08);padding:24px}
  .ok{display:flex;align-items:center;gap:12px;color:#0b7a2a;font-weight:700}
  .ok svg{width:28px;height:28px}
  .name{font-size:28px;font-weight:800;margin:12px 0 6px}
  .muted{color:#666}
  .pill{display:inline-block;background:#e8f0ff;color:#1947e5;padding:6px 12px;border-radius:999px;font-weight:700}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="ok">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12,0A12,12,0,1,0,24,12,12.013,12.013,0,0,0,12,0Zm5.707,8.293-6.364,6.364a1,1,0,0,1-1.414,0L6.293,10.021a1,1,0,1,1,1.414-1.414l3.222,3.222,5.657-5.657a1,1,0,1,1,1.414,1.414Z"/></svg>
      Asistencia registrada
    </div>
    <div class="name">¡Hola, ${nombreMostrado}!</div>
    <div class="muted">ID: <b>${info.id}</b></div>
    <p style="margin:14px 0">${ya ? 'Tu asistencia ya estaba marcada previamente.' : 'Tu asistencia quedó registrada ahora.'}</p>
    <span class="pill">${process.env.EVENT_NAME || 'Evento'}</span>
  </div>
</div>
</body>
</html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error registrando asistencia');
  }
}

app.get('/attend', attendHandler);
app.get('/asistencia', attendHandler); // alias por si hay QR viejos


// Healthcheck útil en Render
app.get('/healthz', (_req, res) => res.send('ok'));

// Home inline (no depende de index.html)
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Asistencia QR</title>
  <style>
    body{font-family:system-ui;margin:24px;max-width:900px}
    img{max-width:220px}
    .card{border:1px solid #ddd;border-radius:10px;padding:12px;margin:10px 0;display:flex;justify-content:space-between;align-items:center;gap:16px}
    .err{background:#fee;border:1px solid #f99;color:#900;padding:10px;border-radius:8px;margin:12px 0}
  </style>
  </head><body>
  <h2>Generar QR (participantes desde Google Sheet)</h2>
  <div id="log" class="err" style="display:none"></div>
  <div id="list">Cargando...</div>

  <script>
  async function load() {
    const log = document.getElementById('log');
    const list = document.getElementById('list');
    try {
      const r = await fetch('/api/participants', { cache: 'no-store' });
      if (!r.ok) {
        const t = await r.text();
        log.style.display='block'; log.textContent = 'Error al cargar participantes: ' + r.status + ' ' + t;
        list.textContent = '';
        return;
      }
      const j = await r.json();
      list.innerHTML = '';

      if (!j.participants || !j.participants.length) {
        list.textContent = 'No hay participantes.';
        return;
      }

      j.participants.forEach(p => {
        const id = p.id || ''; 
        const nombre = p.nombre || '';
        const asis = (p.asistencia || '').toString().toUpperCase() === 'SI';
        const div = document.createElement('div'); 
        div.className = 'card';
        div.innerHTML = 
          '<div>'
        +   '<div><b>' + nombre + '</b></div>'
        +   '<div>ID: ' + id + '</div>'
        +   '<div>Asistencia: ' + (asis ? 'SI' : '-') + '</div>'
        +   '<div style="margin-top:8px">'
        +     '<a href="/qr/' + encodeURIComponent(id) + '.png" download="qr-' + id + '.png">Descargar QR</a>'
        +     ' · '
        +     '<a href="/card/' + encodeURIComponent(id) + '.png" download="card-' + id + '.png">Descargar Card</a>'
        +   '</div>'
        + '</div>'
        + '<div style="text-align:right">'
        +   '<img src="/qr/' + encodeURIComponent(id) + '.png" alt="QR"/>'
        + '</div>';
        list.appendChild(div);
      });
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      log.style.display='block'; 
      log.textContent = 'Excepción en load(): ' + msg;
      list.textContent = '';
      console.error(e);
    }
  }
  load();
  </script>
  </body></html>`);
});


app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
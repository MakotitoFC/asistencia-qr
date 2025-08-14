import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import QRCode from 'qrcode';
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

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

// DEBUG: ver qué encuentra el backend para un ID
app.get('/debug/card/:id', async (req,res)=>{
  const raw = req.params.id;
  const id = decodeURIComponent(raw);
  try{
    const info = await getParticipantById(id);
    res.json({ raw, decoded:id, found: info.rowIndex !== -1, nombre: info.nombre ?? null });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message || 'err' });
  }
});


const THEME = (process.env.THEME_COLOR || '#0b57d0').trim();
const EVENT = (process.env.EVENT_NAME || 'Mi Evento').trim();
const DATE  = (process.env.EVENT_DATE || '').trim();
const LOGO  = path.join(__dirname, 'public', 'logo.png'); // logo local

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

const THEME_CARD = (process.env.THEME_COLOR || '#0b57d0').trim();
const EVENT_CARD = (process.env.EVENT_NAME || 'FULL DAY INCUBIANO').trim();
const DATE_CARD  = (process.env.EVENT_DATE || '').trim();

app.get('/card/:id.png', async (req, res) => {
  try {
    const raw = req.params.id;
    const id  = decodeURIComponent(raw).trim();     // 👈 importante
    if (!id) return res.status(400).send('Falta id');

    // 1) Busca participante
    const info = await getParticipantById(id);
    if (info.rowIndex === -1) return res.status(404).send('ID no encontrado');

    const nombre = (info.nombre || '').trim() || `ID ${info.id}`;

    // 2) URL del QR de asistencia
    const base = (process.env.BASE_URL?.trim()
      ? process.env.BASE_URL.trim().replace(/\/+$/, '')
      : `${req.protocol}://${req.get('host')}`);
    const url  = `${base}/attend?pid=${encodeURIComponent(id)}`;
    const qrPng = await QRCode.toBuffer(url, { width: 640, margin: 1 });

    // 3) Logo local
    const logoPath = path.join(__dirname, 'public', 'logo.png');
    const logoBuf  = await fs.readFile(logoPath).catch(() => null);

    // 4) Composición (apaisado, pro)
    const W = 1400, H = 900; const bg = '#f4f6fb';
    const card = Buffer.from(`
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="${THEME}"/>
            <stop offset="100%" stop-color="#174ea6"/>
          </linearGradient>
          <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#000" flood-opacity="0.12"/>
          </filter>
        </defs>
        <rect width="${W}" height="${H}" fill="${bg}"/>
        <rect x="40" y="40" rx="28" width="${W-80}" height="${H-80}" fill="#fff" filter="url(#shadow)"/>
        <rect x="40" y="40" rx="28" width="${W-80}" height="110" fill="url(#grad)"/>
        <text x="${W/2}" y="110" text-anchor="middle" font-family="Inter,system-ui" font-size="44" font-weight="800" fill="#fff">${EVENT}</text>

        <rect x="80" y="180" rx="20" width="${W-160}" height="${H-260}" fill="#ffffff"/>
        <line x1="${W/2}" y1="200" x2="${W/2}" y2="${H-120}" stroke="#e5e7eb" stroke-width="2"/>

        <text x="120" y="260" font-family="Inter,system-ui" font-size="22" fill="#6b7280">Participante</text>
        <text x="120" y="320" font-family="Inter,system-ui" font-size="42" font-weight="800" fill="#111827">${nombre.replace(/&/g,'&amp;')}</text>
        <text x="120" y="370" font-family="Inter,system-ui" font-size="22" fill="#6b7280">ID</text>
        <text x="120" y="410" font-family="Inter,system-ui" font-size="28" fill="#111827">${id}</text>
        ${DATE ? `<text x="120" y="460" font-family="Inter,system-ui" font-size="22" fill="#9ca3af">${DATE}</text>` : ''}

        <rect x="${W/2 - 180}" y="${H-180}" rx="999" width="360" height="62" fill="${THEME}"/>
        <text x="${W/2}" y="${H-140}" text-anchor="middle" font-family="Inter,system-ui" font-size="24" font-weight="700" fill="#fff">Presenta este QR al ingresar</text>
      </svg>
    `);

    let img = sharp(card);

    if (logoBuf) {
      const logoResized = await sharp(logoBuf).resize({ width: 200, height: 80, fit: 'inside' }).png().toBuffer();
      img = img.composite([{ input: logoResized, top: 60, left: 70 }]);
    }

    img = img.composite([{ input: qrPng, top: 240, left: Math.round(W/2 + 90) }]);

    const out = await img.png().toBuffer();

    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="card-${encodeURIComponent(id)}.png"`,
      'Cache-Control': 'no-store'
    }).send(out);

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
  <title>Credenciales | ${process.env.EVENT_NAME || 'Evento'}</title>
  <style>
    :root{--bg:#0b57d0;--text:#111827;--muted:#6b7280;--card:#fff;--border:#e5e7eb}
    *{box-sizing:border-box} body{margin:0;background:#f3f4f6;font-family:Inter,system-ui}
    header{background:linear-gradient(90deg,var(--bg),#174ea6);color:#fff;padding:18px 24px;display:flex;align-items:center;gap:14px}
    header img{height:36px}
    .container{max-width:1200px;margin:24px auto;padding:0 16px}
    h1{margin:0;font-size:22px;font-weight:800}
    /* 👇 GRID EN COLUMNAS RESPONSIVE */
    .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
    /* Tarjetas verticales (no filas) */
    .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:8px;min-height:160px}
    .name{font-size:18px;font-weight:800;color:var(--text)}
    .sub{color:var(--muted);font-size:14px}
    .btn{appearance:none;border:0;background:var(--bg);color:#fff;padding:10px 14px;border-radius:10px;font-weight:700;cursor:pointer;width:100%;margin-top:auto}
    .btn:active{transform:translateY(1px)}
    .err{background:#fee;border:1px solid #f99;color:#900;padding:10px;border-radius:10px;margin-bottom:12px;display:none}
  </style>
  </head><body>
  <header>
    <img src="/static/logo.png" alt="logo" onerror="this.style.display='none'"/>
    <h1>${process.env.EVENT_NAME || 'Evento'}</h1>
  </header>
  <div class="container">
    <div id="err" class="err"></div>
    <div class="grid" id="list"></div>
  </div>

  <script>
  async function load() {
    const err=document.getElementById('err');
    const list=document.getElementById('list'); list.innerHTML='Cargando...';
    try{
      const r=await fetch('/api/participants',{cache:'no-store'});
      if(!r.ok){err.style.display='block';err.textContent='Error '+r.status+' al cargar participantes';list.innerHTML='';return;}
      const j=await r.json();
      list.innerHTML='';
      if(!j.participants||!j.participants.length){list.innerHTML='<div class="sub">No hay participantes.</div>';return;}
      j.participants.forEach(p=>{
        // 👇 lee id/nombre aunque vengan con otra capitalización o espacios
        const id = ((p.id ?? p.ID ?? p.Id ?? p.iD ?? '').toString()).trim();
        const nombre = ((p.nombre ?? p.Nombre ?? p.name ?? '').toString()).trim();
        const asis = ((p.asistencia ?? p.Asistencia ?? '').toString().trim().toUpperCase()==='SI');

        const item=document.createElement('div'); item.className='card';
        item.innerHTML=
          '<div class="name">'+(nombre||'(sin nombre)')+'</div>'
        + '<div class="sub">ID: '+id+' · Asistencia: '+(asis?'SI':'-')+'</div>'
        + '<button class="btn" onclick="downloadCard(\\''+encodeURIComponent(id)+'\\')">Descargar Card</button>';
        list.appendChild(item);
      });
    }catch(e){err.style.display='block'; err.textContent='Excepción: '+(e.message||e); list.innerHTML='';}
  }
  window.downloadCard = async function(idEnc){
    try{
      const r = await fetch('/card/'+idEnc+'.png', { cache: 'no-store' });
      if(!r.ok){ alert('No se pudo generar la card ('+r.status+')'); return false; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'card-'+decodeURIComponent(idEnc)+'.png';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    }catch(e){ console.error(e); alert('Error descargando la card.'); }
    return false;
  }
  load();
  </script>
  </body></html>`);
});




app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));

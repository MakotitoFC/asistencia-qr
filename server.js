import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import QRCode from 'qrcode';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// sirve estáticos (logo, etc.)
app.use('/static', express.static(path.join(__dirname, 'public')));
// no caché
app.use((req,res,next)=>{ res.set('Cache-Control','no-store'); next(); });

const {
  SHEET_ID,
  SHEET_NAME = 'Asistentes',
  SERVICE_ACCOUNT_EMAIL,
  SERVICE_ACCOUNT_KEY,
  BASE_URL = '',
  EVENT_NAME = 'FULL DAY INCUBIANO',
  EVENT_DATE = '',
  THEME_COLOR = '#0b57d0',
} = process.env;

const PORT = process.env.PORT || 10000;

if (!SHEET_ID || !SERVICE_ACCOUNT_EMAIL || !SERVICE_ACCOUNT_KEY) {
  console.error('Faltan envs: SHEET_ID, SERVICE_ACCOUNT_EMAIL, SERVICE_ACCOUNT_KEY');
  process.exit(1);
}

const auth = new google.auth.JWT({
  email: SERVICE_ACCOUNT_EMAIL,
  key: SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

const headersLower = (arr=[]) => arr.map(x => (x||'').toString().trim().toLowerCase());
const col = i => String.fromCharCode('A'.charCodeAt(0) + i);

async function readAll() {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:C`
  });
  return data.values || [];
}

function parseSheet(values) {
  if (!values || !values.length) return { rows: [], hasHeader: false, headers: ['id','nombre','asistencia']};
  const hdr = headersLower(values[0] || []);
  const headerish = hdr.includes('id') || hdr.includes('nombre') || hdr.includes('asistencia');
  if (headerish) return { rows: values.slice(1), hasHeader: true, headers: hdr };
  return { rows: values, hasHeader: false, headers: ['id','nombre','asistencia'] };
}

async function getParticipantById(id) {
  const values = await readAll();
  const { rows, hasHeader, headers } = parseSheet(values);
  const idxId  = hasHeader ? (headers.indexOf('id') !== -1 ? headers.indexOf('id') : 0) : 0;
  const nameCandidates = ['nombre','nombres','participante','name','nombre y apellido','fullname','full name'];
  let idxNom = 1;
  if (hasHeader) {
    for (const k of nameCandidates) { const i = headers.indexOf(k); if (i !== -1) { idxNom = i; break; } }
  }
  const idxAsis = hasHeader ? (headers.indexOf('asistencia') !== -1 ? headers.indexOf('asistencia') : 2) : 2;

  for (let i=0;i<rows.length;i++) {
    const rowId = (rows[i][idxId] ?? '').toString().trim();
    if (rowId === id.toString().trim()) {
      const rowIndex = (hasHeader ? 2 : 1) + i; // 1-based
      return { rowIndex, headers: hasHeader ? headers : ['id','nombre','asistencia'], id: rowId, nombre: rows[i][idxNom] ?? '', asistencia: rows[i][idxAsis] ?? '', hasHeader, allValues: values };
    }
  }
  return { rowIndex: -1, headers: hasHeader ? headers : ['id','nombre','asistencia'] };
}

async function setAsistenciaSI(rowIndex, headers) {
  const idxAsis = headers.indexOf('asistencia');
  const colLet = idxAsis !== -1 ? col(idxAsis) : 'C';
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!${colLet}${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['SI']] }
  });
}

const getBase = (req) => (BASE_URL?.trim() ? BASE_URL.trim().replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`);

// Busca el logo en /public con varias extensiones (Linux es case-sensitive)
async function loadLogoBuffer() {
  const variants = [
    'logo.png','LOGO.png',
    'logo.jpg','LOGO.jpg',
    'logo.jpeg','LOGO.jpeg',
    'logo.webp','LOGO.webp',
    'logo.svg','LOGO.svg'
  ];
  for (const name of variants) {
    try {
      const p = path.join(__dirname, 'public', name);
      const buf = await fs.readFile(p);
      return buf;
    } catch {}
  }
  return null;
}


// ---- Endpoints ----
app.get('/healthz', (req,res)=>res.type('text').send('ok'));

// Lista de participantes
app.get('/api/participants', async (req, res) => {
  try {
    const values = await readAll();
    if (values.length < 1) return res.json({ participants: [] });
    const { rows, hasHeader, headers } = parseSheet(values);
    const idxId  = hasHeader ? (headers.indexOf('id') !== -1 ? headers.indexOf('id') : 0) : 0;
    const nameCandidates = ['nombre','nombres','participante','name','nombre y apellido','fullname','full name'];
    let idxNom = 1; if (hasHeader) { for (const k of nameCandidates) { const i = headers.indexOf(k); if (i !== -1) { idxNom=i; break; } } }
    const idxAsis = hasHeader ? (headers.indexOf('asistencia') !== -1 ? headers.indexOf('asistencia') : 2) : 2;
    const arr = rows.map(r => ({ id: r[idxId] ?? '', nombre: r[idxNom] ?? '', asistencia: r[idxAsis] ?? '' }));
    res.json({ participants: arr });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo leer la hoja' });
  }
});

// DEBUG: ver resolución de ID
app.get('/debug/card/:id', async (req,res)=>{
  const raw = req.params.id || '';
  const id = decodeURIComponent(raw).trim();
  try {
    const info = await getParticipantById(id);
    res.json({ raw, decoded:id, found: info.rowIndex !== -1, nombre: info.nombre ?? null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'err' });
  }
});

// QR PNG (apunta a /attend?pid=ID)
app.get('/qr/:id.png', async (req,res) => {
  try {
    const id = decodeURIComponent(req.params.id || '').trim();
    if (!id) return res.status(400).send('Falta id');
    const url = `${getBase(req)}/attend?pid=${encodeURIComponent(id)}`;
    const png = await QRCode.toBuffer(url, { width: 700, margin: 1 });
    res.set('Content-Type', 'image/png').send(png);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error generando QR');
  }
});

// CARD PNG
// CARD PNG (logo + barra + QR + nombre + leyenda)
app.get('/card/:id.png', async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id || '').trim();
    if (!id) return res.status(400).send('Falta id');

    // 1) Participante
    const info = await getParticipantById(id);
    if (info.rowIndex === -1) return res.status(404).send('ID no encontrado');
    const nombre = (info.nombre || '').toString().trim() || `ID ${info.id}`;

    // 2) QR
    const base = getBase(req);
    const url = `${base}/attend?pid=${encodeURIComponent(id)}`;
    
    // Layout fijo y orden correcto de cálculos
    const W = 1080, H = 1350;
    const M = 40;
    const cardX = M, cardY = M;
    const cardW = W - 2*M, cardH = H - 2*M;
    const headerH = 200;

    const qrSize = 520;
    const qrTop  = cardY + headerH + 60;
    const qrLeft = Math.round(W/2 - qrSize/2);

    const nameY       = qrTop + qrSize + 60;
    const legendBoxY  = nameY + 26;
    const legendTextY = legendBoxY + 40;

    const svg = Buffer.from(`
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="12" stdDeviation="24" flood-color="#000" flood-opacity="0.16"/>
          </filter>
          <linearGradient id="hdr" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="${THEME_COLOR}"/>
            <stop offset="100%" stop-color="#174ea6"/>
          </linearGradient>
        </defs>

        <rect width="${W}" height="${H}" fill="#f3f4f6"/>
        <g filter="url(#shadow)">
          <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="28" fill="#fff"/>
        </g>

        <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${headerH}" rx="28" fill="url(#hdr)"/>
        <text x="${W/2}" y="${cardY + headerH - 28}" text-anchor="middle"
              font-family="Inter,system-ui" font-size="46" font-weight="800" fill="#fff">
          FULL DAY INCUBIANO
        </text>

        <text x="${W/2}" y="${nameY}" text-anchor="middle"
              font-family="Inter,system-ui" font-size="46" font-weight="800" fill="#111827">
          ${nombre.replace(/&/g,'&amp;')}
        </text>

        <rect x="${cardX + 70}" y="${legendBoxY}" width="${cardW - 140}" height="60"
              rx="14" fill="#eef2ff" stroke="#c7d2fe" stroke-width="1"/>
        <text x="${W/2}" y="${legendTextY}" text-anchor="middle"
              font-family="Inter,system-ui" font-size="24" fill="#4b5563">
          Escanea el QR para registrar tu asistencia
        </text>
      </svg>
    `);
    let img = sharp(svg);

    // Logo en franja (opcional)
    try {
      const logoBuf = await loadLogoBuffer();
      if (logoBuf) {
        const logoH = 60;
        const logoPng = await sharp(logoBuf).resize({ height: logoH, fit: 'inside' }).png().toBuffer();
        const meta = await sharp(logoPng).metadata();
        const lw = meta.width || 160;
        const logoTop  = cardY + Math.round((headerH - logoH)/2);
        const logoLeft = cardX + 24;
        img = img.composite([{ input: logoPng, left: logoLeft, top: logoTop }]);
      }
    } catch(e) { console.warn('Logo:', e.message); }

    // QR centrado
    img = img.composite([{ input: qrPng, left: qrLeft, top: qrTop }]);


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


// Marcar asistencia
async function attendHandler(req, res) {
  try {
    const id = (req.query.pid || '').toString().trim();
    if (!id) return res.status(400).send('Falta pid');

    const info = await getParticipantById(id);
    if (info.rowIndex === -1) return res.status(404).send('ID no encontrado');

    const idxAsis = (info.headers.indexOf('asistencia') !== -1) ? info.headers.indexOf('asistencia') : 2;
    const zeroBasedRow = (info.hasHeader ? info.rowIndex - 2 : info.rowIndex - 1);
    const rows = parseSheet(info.allValues).rows;
    const ya = ((rows[zeroBasedRow][idxAsis] || '').toString().trim().toUpperCase() === 'SI');
    if (!ya) await setAsistenciaSI(info.rowIndex, info.headers);

    const nombreMostrado = (info.nombre || '').toString().trim() || `ID ${info.id}`;

    res.type('html').send(`
<!doctype html><html lang="es"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Asistencia confirmada</title>
<style>
  :root{--brand:${THEME_COLOR};}
  body{margin:0;background:#f5f7fb;color:#0f172a;font-family:Inter,system-ui}
  .actions{width:100%;display:flex;justify-content:flex-end;margin-top:4px}
  .btn-dl{appearance:none;border:1px solid var(--border);background:#fff;border-radius:10px;padding:8px 12px;font-weight:600;cursor:pointer}
  .btn-dl:hover{background:#f9fafb}
  .wrap{max-width:520px;margin:0 auto;padding:24px}
  .hero{background:linear-gradient(90deg,var(--brand),#174ea6);color:#fff;border-radius:18px;padding:22px 20px;display:flex;align-items:center;gap:12px}
  .hero img{height:36px;display:block}
  .panel{background:#fff;border-radius:18px;box-shadow:0 12px 36px rgba(0,0,0,.10);padding:24px;margin-top:14px}
  .ok{display:flex;justify-content:center;align-items:center;margin:8px 0 16px}
  .check{width:68px;height:68px;border-radius:999px;background:#10b981;display:grid;place-items:center;color:#fff;box-shadow:0 8px 18px rgba(16,185,129,.45)}
  .check svg{width:32px;height:32px}
  h2{margin:6px 0 6px;font-size:24px}
  .muted{color:#64748b;margin:6px 0 0}
  .pill{display:inline-block;background:#eff6ff;color:#1d4ed8;padding:6px 12px;border-radius:999px;font-weight:700;margin-top:10px}
  .foot{color:#64748b;font-size:13px;text-align:center;margin-top:10px}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <img src="/static/logo.png" onerror="this.style.display='none'"/>
    <div style="font-weight:800;letter-spacing:.4px">FULL DAY INCUBIANO</div>
  </div>

  <div class="panel">
    <div class="ok"><div class="check">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2l-3.5-3.5L4 14.2 9 19l12-12-1.5-1.5z"/></svg>
    </div></div>
    <h2>¡Asistencia registrada!</h2>
    <div class="muted">Hola, <b>${nombreMostrado}</b> (ID: ${info.id})</div>
    <span class="pill">Gracias por tu ingreso</span>
  </div>

  <div class="foot">Puedes cerrar esta ventana.</div>
</div>
</body></html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error registrando asistencia');
  }
}
app.get('/attend', attendHandler);
app.get('/asistencia', attendHandler); // alias

// Home en columnas con solo “Descargar Card”
// Home: grid de cards (LOGO + Título + QR + Nombre + Leyenda)
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>FULL DAY INCUBIANO</title>
  <style>
    :root{--bg:${THEME_COLOR};--text:#111827;--muted:#6b7280;--card:#fff;--border:#e5e7eb}
    *{box-sizing:border-box} body{margin:0;background:#f3f4f6;font-family:Inter,system-ui}
    header{background:linear-gradient(90deg,var(--bg),#174ea6);color:#fff;padding:18px 24px;display:flex;align-items:center;gap:14px}
    header img{height:40px; width:auto}
    .container{max-width:1200px;margin:24px auto;padding:0 16px}
    h1{margin:0;font-size:22px;font-weight:800}
    .grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
    .card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:0 6px 20px rgba(0,0,0,.04);display:flex;flex-direction:column}
    .card-header{background:linear-gradient(90deg,var(--bg),#174ea6);color:#fff;padding:12px 14px;display:flex;align-items:center;gap:10px}
    .card-header img{height:28px;width:auto;display:block}
    .card-title{font-weight:800;letter-spacing:.5px}
    .card-body{padding:16px;display:flex;flex-direction:column;align-items:center;gap:12px}
    .qr img{width:210px; height:auto; display:block; border-radius:10px; box-shadow:0 3px 12px rgba(0,0,0,.06)}
    .name{font-size:18px;font-weight:800;color:var(--text);text-align:center}
    .hint{color:var(--muted);font-size:14px;background:#f3f6ff;border:1px dashed #c7d2fe;padding:10px 12px;border-radius:10px;text-align:center;width:100%}
    .err{background:#fee;border:1px solid #fbb;color:#900;padding:10px;border-radius:10px;margin-bottom:12px;display:none}
    .toolbar{display:flex;justify-content:flex-end;margin-bottom:12px}
    .toolbar button{appearance:none;border:1px solid var(--border);background:#fff;border-radius:10px;padding:8px 10px;cursor:pointer}
    .toolbar button:hover{background:#f9fafb}
  </style>
  </head><body>
  <header>
    <img src="/static/logo.png" onerror="this.style.display='none'"/>
    <h1>FULL DAY INCUBIANO</h1>
  </header>

  <div class="container">
    <div class="toolbar">
      <button onclick="load()">Actualizar</button>
    </div>
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
      if(!j.participants||!j.participants.length){list.innerHTML='<div class="name" style="opacity:.7">No hay participantes.</div>';return;}
      j.participants.forEach(p=>{
        const id=((p.id??p.ID??p.Id??'')+'').trim();
        const nombre=((p.nombre??p.Nombre??p.name??'')+'').trim()||'(Sin nombre)';
        const card=document.createElement('div'); card.className='card';
        card.innerHTML=
          '<div class="card-header">'
          +   '<img src="/static/logo.png" onerror="this.style.display=\\'none\\'"/>'
          +   '<div class="card-title">FULL DAY INCUBIANO</div>'
          + '</div>'
          + '<div class="card-body">'
          +   '<div class="qr"><img loading="lazy" src="/qr/'+encodeURIComponent(id)+'.png" alt="QR '+id+'"/></div>'
          +   '<div class="name">'+nombre+'</div>'
          +   '<div class="hint">Escanea el QR para registrar tu asistencia</div>'
          +   '<button class="btn" type="button"
                onclick="downloadCard('${encodeURIComponent(id)}')">
                Descargar Card
              </button>';
          + '</div>';
        list.appendChild(card);
      });
    }catch(e){err.style.display='block'; err.textContent='Excepción: '+(e.message||e); list.innerHTML='';}
  }
  // Auto-actualiza cada 30s para captar nuevas filas en el Sheet
  load(); setInterval(load, 30000);
  async function downloadCard(idEnc){
    try{
      const r = await fetch('/card/'+idEnc+'.png', { cache:'no-store' });
      if(!r.ok){ alert('No se pudo generar la card ('+r.status+')'); return; }
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'card-'+decodeURIComponent(idEnc)+'.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }catch(e){
      console.error(e);
      alert('Error descargando la card.');
    }
  }
  </script>
  </body></html>`);
});


app.listen(PORT, () => console.log('OK en ' + (BASE_URL || ('http://localhost:'+PORT))));

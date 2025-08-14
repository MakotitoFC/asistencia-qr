import 'dotenv/config';
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

const THEME_BLUE   = (process.env.THEME_COLOR || '#0b57d0').trim();
const THEME_YELLOW = (process.env.THEME_YELLOW || '#fbbc04').trim(); // amarillo

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

// CARD PNG (logo local + título + QR + leyenda + nombre)
app.get('/card/:id.png', async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id || '').trim();
    if (!id) return res.status(400).send('Falta id');

    // 1) Busca participante (para el nombre)
    const info = await getParticipantById(id);
    if (info.rowIndex === -1) return res.status(404).send('ID no encontrado');
    const nombre = (info.nombre || '').toString().trim() || `ID ${info.id}`;

    // 2) URL del QR de asistencia
    const base = getBase(req);
    const url  = `${base}/attend?pid=${encodeURIComponent(id)}`;
    const qrPng = await QRCode.toBuffer(url, { width: 680, margin: 1 });

    // 3) Cargar LOGO: primero local (public/logo.*), luego EVENT_LOGO_URL si existe
    async function loadLogoBuffer() {
      const tryFiles = ['logo.png','logo.jpg','logo.jpeg','logo.webp','logo.svg'];
      for (const f of tryFiles) {
        try {
          const p = path.join(__dirname, 'public', f);
          const buf = await fs.readFile(p);
          return buf;
        } catch {}
      }
      if (process.env.EVENT_LOGO_URL) {
        try {
          const r = await fetch(process.env.EVENT_LOGO_URL);
          if (r.ok) return Buffer.from(await r.arrayBuffer());
        } catch {}
      }
      return null;
    }
    const logoBuf = await loadLogoBuffer();

    // 4) SVG con PATRONES azul/amarillo + cabecera y slots de texto
    const W = 1080, H = 1350;  // vertical para móvil
    const svg = Buffer.from(`
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <!-- Gradiente cabecera -->
          <linearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"  stop-color="${THEME_BLUE}"/>
            <stop offset="100%" stop-color="#174ea6"/>
          </linearGradient>

          <!-- Patrón de puntitos (amarillo) -->
          <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse">
            <circle cx="4" cy="4" r="3" fill="${THEME_YELLOW}" opacity="0.18"/>
          </pattern>

          <!-- Patrón de líneas (azul), rotado -->
          <pattern id="stripes" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect x="0" y="0" width="5" height="10" fill="${THEME_BLUE}" opacity="0.07"/>
          </pattern>

          <!-- Clip de la tarjeta con esquinas redondeadas -->
          <clipPath id="clip">
            <rect x="40" y="40" rx="28" width="${W-80}" height="${H-80}"/>
          </clipPath>

          <!-- Sombra suave -->
          <filter id="sh" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#000" flood-opacity="0.12"/>
          </filter>
        </defs>

        <!-- Fondo general -->
        <rect width="${W}" height="${H}" fill="#eef2f7"/>

        <!-- Tarjeta -->
        <rect x="40" y="40" rx="28" width="${W-80}" height="${H-80}" fill="#fff" filter="url(#sh)"/>

        <!-- Patrones dentro de la tarjeta (muy sutiles para no afectar el QR) -->
        <g clip-path="url(#clip)">
          <rect x="40" y="40" width="${W-80}" height="${H-80}" fill="url(#stripes)"/>
          <rect x="40" y="40" width="${W-80}" height="${H-80}" fill="url(#dots)"/>
          <!-- Unas manchas decorativas -->
          <circle cx="${W-160}" cy="160" r="110" fill="${THEME_YELLOW}" opacity="0.12"/>
          <circle cx="120" cy="${H-160}" r="120" fill="${THEME_BLUE}" opacity="0.10"/>
        </g>

        <!-- Banda de cabecera -->
        <rect x="40" y="40" rx="28" width="${W-80}" height="120" fill="url(#grad)"/>
        <text x="${W/2}" y="115" text-anchor="middle" font-family="Inter,system-ui" font-size="44" font-weight="800" fill="#fff">FULL DAY INCUBIANO</text>

        <!-- Leyenda -->
        <text x="${W/2}" y="340" text-anchor="middle" font-family="Inter,system-ui" font-size="22" fill="#6b7280">
          Escanea el QR para registrar asistencia
        </text>

        <!-- Nombre + ID/fecha -->
        <text id="nombreSlot" x="${W/2}" y="${H-210}" text-anchor="middle" font-family="Inter,system-ui"
              font-size="38" font-weight="800" fill="#111827">${nombre.replace(/&/g,'&amp;')}</text>
        <text x="${W/2}" y="${H-170}" text-anchor="middle" font-family="Inter,system-ui" font-size="22" fill="#6b7280">
          ID: ${id}${process.env.EVENT_DATE ? ' · ' + process.env.EVENT_DATE : ''}
        </text>
      </svg>
    `);

    // 5) Composición con sharp
    let img = sharp(svg);

    // Logo centrado arriba (si existe)
    if (logoBuf) {
      const logo = await sharp(logoBuf).resize({ width: 220, height: 100, fit: 'inside' }).png().toBuffer();
      // centrado horizontalmente dentro de la tarjeta
      const left = Math.round((W - 220) / 2);
      // lo ponemos en la zona blanca, justo debajo de la banda
      img = img.composite([{ input: logo, top: 170, left }]);
    }

    // QR centrado
    img = img.composite([{ input: qrPng, top: 380, left: Math.round((W - 680) / 2) }]);

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
    <span class="pill">${EVENT_NAME}</span>
  </div>
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
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Credenciales | ${EVENT_NAME}</title>
  <style>
    :root{--bg:${THEME_COLOR};--text:#111827;--muted:#6b7280;--card:#fff;--border:#e5e7eb}
    *{box-sizing:border-box} body{margin:0;background:#f3f4f6;font-family:Inter,system-ui}
    header{background:linear-gradient(90deg,var(--bg),#174ea6);color:#fff;padding:18px 24px;display:flex;align-items:center;gap:14px}
    header img{height:36px}
    .container{max-width:1200px;margin:24px auto;padding:0 16px}
    h1{margin:0;font-size:22px;font-weight:800}
    .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
    .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:8px;min-height:160px}
    .name{font-size:18px;font-weight:800;color:var(--text)}
    .sub{color:var(--muted);font-size:14px}
    .btn{appearance:none;border:0;background:var(--bg);color:#fff;padding:10px 14px;border-radius:10px;font-weight:700;cursor:pointer;width:100%;margin-top:auto}
    .btn:active{transform:translateY(1px)}
    .err{background:#fee;border:1px solid #f99;color:#900;padding:10px;border-radius:10px;margin-bottom:12px;display:none}
  </style>
  </head><body>
  <header>
    // <img src="/static/LOGO_W.png" alt="logo" onerror="this.style.display='none'"/>
    <h1>${EVENT_NAME}</h1>
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
        const id=((p.id??p.ID??p.Id??'')+'').trim();
        const nombre=((p.nombre??p.Nombre??p.name??'')+'').trim();
        const asis=((p.asistencia??p.Asistencia??'')+'').trim().toUpperCase()==='SI';
        const item=document.createElement('div'); item.className='card';
        item.innerHTML=
          '<div class="name">'+(nombre||'(sin nombre)')+'</div>'
        + '<div class="sub">ID: '+id+' · Asistencia: '+(asis?'SI':'-')+'</div>'
        + '<button class="btn" onclick="downloadCard(\\''+encodeURIComponent(id)+'\\')">Descargar Card</button>';
        list.appendChild(item);
      });
    }catch(e){err.style.display='block'; err.textContent='Excepción: '+(e.message||e); list.innerHTML='';}
  }
  window.downloadCard=async function(idEnc){
    try{
      const r=await fetch('/card/'+idEnc+'.png',{cache:'no-store'});
      if(!r.ok){alert('No se pudo generar la card ('+r.status+')');return false;}
      const blob=await r.blob(); const url=URL.createObjectURL(blob);
      const a=document.createElement('a'); a.href=url; a.download='card-'+decodeURIComponent(idEnc)+'.png'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    }catch(e){console.error(e); alert('Error descargando la card.');}
    return false;
  }
  load();
  </script>
  </body></html>`);
});

app.listen(PORT, () => console.log('OK en ' + (BASE_URL || ('http://localhost:'+PORT))));

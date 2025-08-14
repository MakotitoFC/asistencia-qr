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
    const qrSize = 520;
    const qrPng  = await QRCode.toBuffer(url, { width: qrSize, margin: 1 });

    // 3) Layout
    const W = 1080, H = 1350;

    // Tarjeta
    const cardX = 40, cardY = 40;
    const cardW = W - 80, cardH = H - 80;

    // Banda superior
    const headerH = 200;

    // Cuerpo
    const bodyTop = cardY + headerH + 40;

    // QR centrado
    const qrLeft = Math.round((W - qrSize) / 2);
    const qrTop  = bodyTop;

    // Textos debajo del QR
    const nameY = qrTop + qrSize + 90;
    const hintY = nameY + 48;

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

        <!-- Fondo -->
        <rect width="${W}" height="${H}" fill="#f3f4f6"/>

        <!-- Tarjeta -->
        <g filter="url(#shadow)">
          <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="28" fill="#fff"/>
        </g>

        <!-- Banda -->
        <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${headerH}" rx="28" fill="url(#hdr)"/>
        <text x="${W/2}" y="${cardY + 130}" text-anchor="middle"
              font-family="Inter,system-ui" font-size="46" font-weight="800" fill="#ffffff">
          FULL DAY INCUBIANO
        </text>

        <!-- Leyenda (solo el contenedor y coordenadas; el texto va aquí) -->
        <rect x="${cardX + 70}" y="${hintY - 28}" width="${cardW - 140}" height="60"
              rx="14" fill="#eef2ff" stroke="#c7d2fe" stroke-width="1"/>
        <text x="${W/2}" y="${hintY + 12}" text-anchor="middle"
              font-family="Inter,system-ui" font-size="24" fill="#4b5563">
          Escanea el QR para registrar tu asistencia
        </text>

        <!-- Nombre -->
        <text x="${W/2}" y="${nameY}" text-anchor="middle"
              font-family="Inter,system-ui" font-size="44" font-weight="800" fill="#111827">
          ${nombre.replace(/&/g,'&amp;')}
        </text>
      </svg>
    `);

    let img = sharp(svg);

    // 4) Logo centrado en la banda (si existe)
    try {
      const logoBuf = await loadLogoBuffer();
      if (logoBuf) {
        const logoPng = await sharp(logoBuf).resize({ height: 84, fit: 'inside' }).png().toBuffer();
        const meta = await sharp(logoPng).metadata();
        const lw = meta.width || 160;
        const left = Math.round(W / 2 - lw / 2);
        const top  = cardY + 30;
        img = img.composite([{ input: logoPng, left, top }]);
      }
    } catch (_) {}

    // 5) Pegar el QR
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

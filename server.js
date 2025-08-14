// CARD PNG (franja superior amplia con degradado + logo centrado, sin rombos)
app.get('/card/:id.png', async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id || '').trim();
    if (!id) return res.status(400).send('Falta id');

    // 1) Participante
    const info = await getParticipantById(id);
    if (info.rowIndex === -1) return res.status(404).send('ID no encontrado');
    const nombre = (info.nombre || '').toString().trim() || `ID ${info.id}`;

    // 2) QR de asistencia (tamaño ajustado al layout)
    const base = getBase(req);
    const url  = `${base}/attend?pid=${encodeURIComponent(id)}`;
    const QR_SIZE = 560;
    const qrPng = await QRCode.toBuffer(url, { width: QR_SIZE, margin: 1 });

    // 3) Layout
    const W = 1080, H = 1500;                // un poquito más alto para respiración
    const THEME = THEME_COLOR || '#0b57d0';

    // Tarjeta (márgenes y dimensiones)
    const cardX = 28, cardY = 28;
    const cardW = W - cardX*2;
    const cardH = H - cardY*2;

    // Franja superior (más ancha)
    const HDR_H = 260;                       // << aquí hacemos la franja más ancha

    // Dimensiones para textos/elementos
    const qrTop  = cardY + HDR_H + 70;
    const qrLeft = Math.round((W - QR_SIZE) / 2);

    const nameY  = qrTop + QR_SIZE + 120;

    // “pill” de leyenda
    const pillW  = 880;
    const pillH  = 84;
    const pillX  = Math.round((W - pillW) / 2);
    const pillY  = nameY + 30;

    // Pie inferior
    const FOOT_H = 110;

    // 4) SVG base (sin rombos, con degradado y tipografía)
    const svg = Buffer.from(`
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="16" stdDeviation="22" flood-color="#000" flood-opacity="0.16"/>
          </filter>
          <linearGradient id="hdr" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="${THEME}"/>
            <stop offset="100%" stop-color="#174ea6"/>
          </linearGradient>
        </defs>

        <!-- Fondo -->
        <rect width="${W}" height="${H}" fill="#eef2f7"/>

        <!-- Tarjeta blanca con sombra suave -->
        <g filter="url(#shadow)">
          <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="26" fill="#ffffff"/>
        </g>

        <!-- Franja superior (degradado) -->
        <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${HDR_H}" rx="26" fill="url(#hdr)"/>

        <!-- Título del evento -->
        <text x="${W/2}" y="${cardY + 170}" text-anchor="middle"
              font-family="Inter,system-ui" font-size="64" font-weight="800" fill="#ffffff">
          ${EVENT_NAME}
        </text>

        <!-- Nombre -->
        <text x="${W/2}" y="${nameY}" text-anchor="middle"
              font-family="Inter,system-ui" font-size="56" font-weight="800" fill="#1f2937">
          ${nombre.replace(/&/g,'&amp;')}
        </text>

        <!-- Pill de leyenda -->
        <rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="20" fill="#eef1f5"/>
        <text x="${W/2}" y="${pillY + 55}" text-anchor="middle"
              font-family="Inter,system-ui" font-size="30" font-weight="700" fill="#4b5563">
          ESCANEA EL QR PARA REGISTRAR TU ASISTENCIA
        </text>

        <!-- Pie inferior -->
        <rect x="${cardX}" y="${cardY + cardH - FOOT_H}" width="${cardW}" height="${FOOT_H}" rx="0" fill="#f3f4f6"/>
        <text x="${W/2}" y="${cardY + cardH - FOOT_H/2 + 10}" text-anchor="middle"
              font-family="Inter,system-ui" font-size="30" fill="#6b7280">
          ${EVENT_DATE ? EVENT_DATE + ' · ' : ''}Evento exclusivo para miembros Incubianos
        </text>
      </svg>
    `);

    let img = sharp(svg);

    // 5) Logo centrado en la franja superior (se carga de /public/logo.*)
    try {
      const logoFile = await loadLogoBuffer();                // usa tu helper existente
      if (logoFile) {
        // Altura objetivo 120 px (cabecera es 260)
        const resized = sharp(logoFile).resize({ height: 120, fit: 'inside' }).png();
        const { data: logoBuf, info: meta } = await resized.toBuffer({ resolveWithObject: true });
        const left = Math.round((W - meta.width) / 2);
        const top  = Math.round(cardY + (HDR_H - meta.height) / 2);
        img = img.composite([{ input: logoBuf, left, top }]);
      } else {
        console.warn('Logo no encontrado en /public (logo.png|jpg|jpeg|webp|svg)');
      }
    } catch (e) {
      console.warn('Error al poner el logo:', e.message);
    }

    // 6) QR centrado debajo de la franja
    img = img.composite([{ input: qrPng, left: qrLeft, top: qrTop }]);

    // 7) Respuesta
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

// Servidor HTTP do bot. Fica só na rede interna do Docker: quem fala com ele é o
// servidor da página, sempre com a CHAVE_INTERNA (x-api-token).
//   GET  /health               → vivo? (sem chave; usado pelo healthcheck)
//   GET  /status               → estado do WhatsApp + QR (data URL) para parear
//   POST /api/enviar           → envia cobrança (src/api-envio.js)
//   POST /api/financas/extrair → lê fatura com IA (src/api-financas.js)
'use strict';
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');

function igual(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s || '')).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

function criarServidorHttp({ token, getStatus, getQr, rotasEnvio, rotasFinancas }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => res.json({ ok: true, whatsapp: getStatus() }));

  app.get('/status', async (req, res) => {
    if (!token || !igual(req.get('x-api-token'), token)) return res.status(401).json({ erro: 'Token inválido.' });
    const qr = getStatus() !== 'connected' && getQr() ? await QRCode.toDataURL(getQr(), { width: 320, margin: 1 }) : null;
    res.json({ whatsapp: getStatus(), qr });
  });

  // Leitura de fatura recebe PDF/foto: tem parser próprio, com limite maior.
  if (rotasFinancas) app.use('/api/financas', rotasFinancas);
  app.use(express.json({ limit: '256kb' }));
  if (rotasEnvio) app.use('/api', rotasEnvio);
  return app;
}

module.exports = { criarServidorHttp };

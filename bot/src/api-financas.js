// Leitura de faturas para a página de finanças: POST /api/financas/extrair
// Recebe texto colado e/ou um arquivo (imagem ou PDF em base64) e devolve os itens.
// Mesmo token do /api/enviar (x-api-token), que a página já guarda nas configurações.
const express = require('express');
const { extrairFatura } = require('./financas-ia');

const TIPOS_ACEITOS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);
const LIMITE_ARQUIVO_BYTES = 12 * 1024 * 1024;

function criarRotasFinancas({ ai, token, log }) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-token',
      'Access-Control-Max-Age': '86400',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  // Fatura em PDF ou foto passa fácil dos 256 kB do parser geral.
  router.use(express.json({ limit: '20mb' }));

  router.post('/extrair', async (req, res) => {
    if (!token) return res.status(503).json({ erro: 'Leitura desativada: configure API_TOKEN no .env do bot.' });
    if (req.get('x-api-token') !== token) return res.status(401).json({ erro: 'Token inválido ou ausente.' });
    if (!ai || typeof ai.gerarJson !== 'function') return res.status(503).json({ erro: 'Motor de IA indisponível no bot.' });

    const { texto, arquivo } = req.body || {};
    const temTexto = typeof texto === 'string' && texto.trim().length > 0;
    let anexo = null;
    if (arquivo) {
      const tipo = String(arquivo.mimeType || '').toLowerCase();
      if (!TIPOS_ACEITOS.has(tipo)) return res.status(400).json({ erro: `Tipo de arquivo não suportado (${tipo || 'desconhecido'}). Use PDF, JPG, PNG ou WEBP.` });
      const buffer = Buffer.from(String(arquivo.base64 || ''), 'base64');
      if (!buffer.length) return res.status(400).json({ erro: 'Arquivo vazio.' });
      if (buffer.length > LIMITE_ARQUIVO_BYTES) return res.status(413).json({ erro: 'Arquivo grande demais (máx. 12 MB).' });
      anexo = { buffer, mimeType: tipo };
    }
    if (!temTexto && !anexo) return res.status(400).json({ erro: 'Envie o texto da fatura ou um arquivo.' });

    const t0 = Date.now();
    try {
      const fatura = await extrairFatura({ ai, texto: temTexto ? texto : '', arquivo: anexo });
      log.info({ itens: fatura.itens.length, segundos: (Date.now() - t0) / 1000, arquivo: anexo ? anexo.mimeType : null }, 'fatura lida para a página');
      return res.json({ sucesso: true, fatura });
    } catch (err) {
      log.error({ err }, 'falha ao ler fatura');
      return res.status(502).json({ erro: `Não consegui ler a fatura: ${err.message}` });
    }
  });

  return router;
}

module.exports = { criarRotasFinancas, TIPOS_ACEITOS };

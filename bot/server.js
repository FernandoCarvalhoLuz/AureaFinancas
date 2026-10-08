// Áurea · bot do WhatsApp (só finanças)
// - Envia as cobranças pedidas pela página.
// - Lê faturas (PDF, foto, texto) com IA para a página.
// - Num grupo vinculado com !financas, conversa e lança gastos — só depois do OK.
'use strict';
const path = require('path');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const store = require('./src/store');
const { createAiGemini } = require('./src/ai-gemini');
const { createAiOpenAI } = require('./src/ai-openai');
const { criarComFallback } = require('./src/ai-fallback');
const { startWhatsApp } = require('./src/whatsapp');
const { criarRotasEnvio } = require('./src/api-envio');
const { criarRotasFinancas } = require('./src/api-financas');
const { criarAgenteFinancas, criarApiFinancas } = require('./src/financas-agente');
const { criarServidorHttp } = require('./src/servidor-http');
const { criarVerificador } = require('./src/autorizacao');

async function main() {
  const log = pino({ level: process.env.LOG_LEVEL || 'info' });
  const cfg = {
    porta: Number(process.env.BOT_PORT || 8081),
    chave: process.env.CHAVE_INTERNA || '',
    financasUrl: process.env.FINANCAS_URL || 'http://app:8080',
    urlPublica: process.env.URL_PUBLICA || '',
    motor: (process.env.IA_MOTOR || 'gemini').toLowerCase(),
  };
  if (cfg.chave.length < 24) {
    log.error('CHAVE_INTERNA ausente ou curta (mínimo 24 caracteres). Confira o .env.');
    process.exit(1);
  }

  const motores = {
    gemini: () => process.env.GEMINI_API_KEY && createAiGemini({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || undefined, log }),
    openai: () => process.env.OPENAI_API_KEY && createAiOpenAI({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || undefined, log }),
  };
  const outro = cfg.motor === 'openai' ? 'gemini' : 'openai';
  const ai = criarComFallback({ principal: (motores[cfg.motor] || motores.gemini)() || null, reserva: motores[outro]() || null, log });
  if (ai) log.info({ motor: ai.nome }, 'motor de IA ativo');
  else log.warn('sem GEMINI_API_KEY nem OPENAI_API_KEY: cobranças funcionam, mas leitura de faturas e lançamentos pelo WhatsApp não.');

  let wa = null;
  let ultimoQr = null;

  const agente = criarAgenteFinancas({
    ai,
    api: criarApiFinancas({ baseUrl: cfg.financasUrl, apiKey: cfg.chave }),
    send: (jid, texto) => wa.send(jid, texto),
    log,
    urlPagina: cfg.urlPublica,
  });

  // Só o próprio número do bot ou números autorizados vinculam um grupo (src/autorizacao.js).
  const podeVincular = criarVerificador(process.env.NUMEROS_AUTORIZADOS);

  async function despachar(msg) {
    const texto = String(msg.text || '').trim().toLowerCase();
    if (texto === '!financas' || texto === '!finanças') {
      if (!podeVincular(msg)) {
        log.warn({ remetente: msg.remetente, grupo: msg.chatJid }, '!financas recusado: remetente fora de NUMEROS_AUTORIZADOS');
        return wa.send(msg.chatJid, '⛔ Só o dono desta instalação pode vincular um grupo. (Peça para incluir seu número em NUMEROS_AUTORIZADOS.)');
      }
      store.setFinanceGroup(msg.chatJid);
      return wa.send(msg.chatJid, [
        '✅ Grupo de finanças vinculado!',
        'Mande aqui seus gastos por texto, áudio, foto ou PDF. Ex.: "Uber 32,50 no Nubank, eu" ou "tênis 300 em 3x no Mercado Livre, dividir com a Ana".',
        'Eu confirmo mês, conta, quem paga e parcelas, e só lanço depois do seu OK.',
      ].join('\n'));
    }
    if (texto === '!financas sair' || texto === '!finanças sair') {
      if (msg.chatJid !== store.getFinanceGroup() || !podeVincular(msg)) return undefined;
      store.setFinanceGroup(null);
      return wa.send(msg.chatJid, '👋 Grupo desvinculado. Não vou mais ler lançamentos aqui.');
    }
    if (msg.chatJid === store.getFinanceGroup()) return agente.handleMessage(msg);
    return undefined; // outros grupos: o bot fica quieto
  }

  wa = await startWhatsApp({
    authDir: path.join(store.dataDir(), 'auth'),
    logger: pino({ level: 'warn' }),
    onQr: (qr) => {
      ultimoQr = qr;
      if (qr) {
        log.info('novo QR gerado — abra a página › Configurações para conectar o número (ou leia o QR abaixo)');
        qrcodeTerminal.generate(qr, { small: true });
      }
    },
    onStatus: (s) => log.info({ whatsapp: s }, 'status da conexão'),
    onMessage: (msg) => despachar(msg),
    querAnexo: (jid) => jid === store.getFinanceGroup(),
  });

  const app = criarServidorHttp({
    token: cfg.chave,
    getStatus: wa.getStatus,
    getQr: () => ultimoQr,
    rotasEnvio: criarRotasEnvio({ wa, token: cfg.chave, log }),
    rotasFinancas: criarRotasFinancas({ ai, token: cfg.chave, log }),
  });
  app.listen(cfg.porta, '0.0.0.0', () => log.info(`bot ouvindo na porta ${cfg.porta} (rede interna)`));
}

main().catch((err) => {
  console.error('Falha fatal na inicialização:', err);
  process.exit(1);
});

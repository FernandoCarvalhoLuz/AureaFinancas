const fs = require('fs');
const path = require('path');
const express = require('express');

const PASTA_MEDIA = path.join(__dirname, '..', 'media');

// Só nomes simples: barra, ponto-ponto e extensão são recusados (evita ler fora de media/)
const NOME_AUDIO_VALIDO = /^[a-z0-9_-]+$/i;

// Converte "(21) 99999-8888", "+55 21 99999-8888" etc. em JID do WhatsApp.
// JIDs já prontos (@s.whatsapp.net, @g.us) passam intactos. Inválido → null.
function normalizarNumero(entrada) {
  if (!entrada || typeof entrada !== 'string') return null;
  const bruto = entrada.trim();
  if (/@(s\.whatsapp\.net|g\.us|c\.us)$/.test(bruto)) {
    return bruto.replace(/@c\.us$/, '@s.whatsapp.net');
  }
  let digitos = bruto.replace(/\D/g, '');
  if (!digitos) return null;
  if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;
  // Números brasileiros válidos: 55 + DDD (2) + 8 ou 9 dígitos
  if (!/^55\d{10,11}$/.test(digitos)) return null;
  return `${digitos}@s.whatsapp.net`;
}

/**
 * Rotas de envio de mensagens usando a sessão do WhatsApp já conectada.
 * Consome: wa.getStatus(), wa.send(jid, texto), wa.verificarNumero(jid) -> boolean
 */
function criarRotasEnvio({
  wa,
  token,
  log,
  intervaloMs = 3000,
  audioExiste = (nome) => fs.existsSync(path.join(PASTA_MEDIA, `${nome}.ogg`)),
  caminhoAudio = (nome) => path.join(PASTA_MEDIA, `${nome}.ogg`),
}) {
  const router = express.Router();

  // O app de finanças roda em outra porta, então o navegador exige CORS.
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

  // Fila serial: o WhatsApp bloqueia números que disparam muitas mensagens de uma vez.
  let fila = Promise.resolve();
  function enfileirar(tarefa) {
    const resultado = fila.then(tarefa, tarefa);
    fila = resultado.then(
      () => new Promise((r) => setTimeout(r, intervaloMs)),
      () => new Promise((r) => setTimeout(r, intervaloMs))
    );
    return resultado;
  }

  router.post('/enviar', async (req, res) => {
    if (!token) {
      return res.status(503).json({ erro: 'Envio por API desativado: configure API_TOKEN no .env do bot.' });
    }
    if (req.get('x-api-token') !== token) {
      return res.status(401).json({ erro: 'Token inválido ou ausente.' });
    }

    const { numero, texto, audio } = req.body || {};
    if (!numero || !texto || typeof texto !== 'string' || !texto.trim()) {
      return res.status(400).json({ erro: 'Campos "numero" e "texto" são obrigatórios.' });
    }

    if (audio !== undefined && audio !== null && audio !== '') {
      if (typeof audio !== 'string' || !NOME_AUDIO_VALIDO.test(audio)) {
        return res.status(400).json({ erro: 'Nome de áudio inválido. Use apenas letras, números, hífen ou sublinhado.' });
      }
      if (!audioExiste(audio)) {
        return res.status(400).json({ erro: `Áudio "${audio}" não encontrado na pasta media/ do bot.` });
      }
    }

    const jid = normalizarNumero(numero);
    if (!jid) {
      return res.status(400).json({ erro: `Número inválido: "${numero}". Use DDD + número, ex.: 21999998888.` });
    }

    if (wa.getStatus() !== 'connected') {
      return res.status(503).json({ erro: 'WhatsApp desconectado no servidor. Verifique a página /qr do bot.' });
    }

    try {
      const existe = await wa.verificarNumero(jid);
      if (!existe) {
        return res.status(404).json({ erro: 'Esse número não tem WhatsApp (ou está incorreto).' });
      }
      await enfileirar(() => wa.send(jid, texto));

      // O áudio é um complemento: se falhar, o texto já foi entregue e a chamada
      // continua sendo um sucesso — apenas sinalizamos que o áudio não foi junto.
      let audioEnviado = false;
      if (audio) {
        try {
          await enfileirar(() => wa.sendAudio(jid, caminhoAudio(audio)));
          audioEnviado = true;
        } catch (err) {
          log.error({ err, jid }, 'texto enviado, mas o áudio falhou');
        }
      }

      log.info({ jid, audioEnviado }, 'mensagem enviada pela API');
      return res.json({ sucesso: true, jid, audioEnviado });
    } catch (err) {
      log.error({ err }, 'falha ao enviar mensagem pela API');
      return res.status(500).json({ erro: `Erro ao enviar: ${err.message}` });
    }
  });

  return router;
}

module.exports = { criarRotasEnvio, normalizarNumero };

const fs = require('fs');

function extractContent(waMsg) {
  const m = waMsg && waMsg.message;
  if (!m) return null;
  if (m.conversation) return { text: m.conversation };
  if (m.extendedTextMessage && m.extendedTextMessage.text) return { text: m.extendedTextMessage.text };
  if (m.audioMessage) return { audio: { mimeType: m.audioMessage.mimetype || 'audio/ogg' } };
  return null;
}

// Imagem ou documento (foto de comprovante, PDF de fatura). Separado de extractContent
// de propósito: só os chats que pedem (querAnexo, o grupo de finanças) recebem o download.
const LIMITE_ANEXO_BYTES = 15 * 1024 * 1024;
function extractAnexo(waMsg) {
  const m = waMsg && waMsg.message;
  if (!m) return null;
  const doc = m.documentMessage
    || (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message && m.documentWithCaptionMessage.message.documentMessage);
  const midia = m.imageMessage || doc;
  if (!midia) return null;
  return {
    mimeType: (midia.mimetype || (m.imageMessage ? 'image/jpeg' : 'application/octet-stream')).split(';')[0].trim(),
    caption: midia.caption || '',
    tamanho: Number(midia.fileLength || 0),
  };
}

async function loadBaileys() {
  const mod = await import('baileys');
  const ex = mod.default && (mod.default.makeWASocket || mod.default.useMultiFileAuthState) ? mod.default : mod;
  return {
    makeWASocket: ex.makeWASocket || mod.makeWASocket || mod.default,
    useMultiFileAuthState: ex.useMultiFileAuthState || mod.useMultiFileAuthState,
    DisconnectReason: ex.DisconnectReason || mod.DisconnectReason,
    downloadMediaMessage: ex.downloadMediaMessage || mod.downloadMediaMessage,
  };
}

async function startWhatsApp({ authDir, logger, onQr, onStatus, onMessage, querAnexo = () => false }) {
  const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = await loadBaileys();
  const sentIds = new Set();
  let sock = null;
  let status = 'starting';
  let reconnectDelay = 2000;

  function setStatus(s) {
    status = s;
    onStatus(s);
  }

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    sock = makeWASocket({ auth: state, logger, markOnlineOnConnect: false });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      if (u.qr) {
        setStatus('waiting_qr');
        onQr(u.qr);
      }
      if (u.connection === 'open') {
        reconnectDelay = 2000;
        onQr(null);
        setStatus('connected');
      }
      if (u.connection === 'close') {
        setStatus('disconnected');
        const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output
          ? u.lastDisconnect.error.output.statusCode
          : undefined;
        if (code === DisconnectReason.loggedOut) {
          logger.warn('sessão invalidada (logout); limpando credenciais para gerar novo QR');
          fs.rmSync(authDir, { recursive: true, force: true });
        }
        setTimeout(() => connect().catch((err) => logger.error({ err }, 'falha ao reconectar')), reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 60000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const waMsg of messages) {
        try {
          if (!waMsg.message || !waMsg.key) continue;
          if (sentIds.has(waMsg.key.id)) continue; // eco de mensagem enviada pelo próprio bot
          const chatJid = waMsg.key.remoteJid;
          if (!chatJid || !chatJid.endsWith('@g.us')) continue; // só grupos
          let content = extractContent(waMsg);
          let anexo = null;
          if (!content && querAnexo(chatJid)) {
            const a = extractAnexo(waMsg);
            if (a && a.tamanho <= LIMITE_ANEXO_BYTES) {
              const buffer = await downloadMediaMessage(waMsg, 'buffer', {}, {
                logger,
                reuploadRequest: sock.updateMediaMessage,
              });
              anexo = { buffer, mimeType: a.mimeType };
              content = { text: a.caption || null };
            }
          }
          if (!content) continue;
          let audio = null;
          if (content.audio) {
            const buffer = await downloadMediaMessage(waMsg, 'buffer', {}, {
              logger,
              reuploadRequest: sock.updateMediaMessage,
            });
            audio = { buffer, mimeType: content.audio.mimeType };
          }
          // Quem mandou: em grupos o Baileys pode trazer o LID; o número de telefone vem em participantAlt.
          const k = waMsg.key;
          const remetente = k.participantAlt || k.participantPn || k.participant || null;
          await onMessage({
            chatJid, isGroup: true, text: content.text || null, audio, anexo,
            autor: waMsg.pushName || null, remetente, deMim: Boolean(k.fromMe),
          });
        } catch (err) {
          logger.error({ err }, 'erro ao processar mensagem recebida');
        }
      }
    });
  }

  await connect();

  return {
    getStatus: () => status,
    async send(jid, text) {
      const sent = await sock.sendMessage(jid, { text });
      if (sent && sent.key && sent.key.id) {
        sentIds.add(sent.key.id);
        if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value);
      }
      return sent;
    },
    // Envia um arquivo .ogg/opus como mensagem de voz (ptt)
    async sendAudio(jid, caminhoArquivo) {
      const buffer = fs.readFileSync(caminhoArquivo);
      const sent = await sock.sendMessage(jid, {
        audio: buffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
      });
      if (sent && sent.key && sent.key.id) {
        sentIds.add(sent.key.id);
        if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value);
      }
      return sent;
    },
    // Confere se o número realmente tem WhatsApp antes de tentar enviar
    async verificarNumero(jid) {
      if (jid.endsWith('@g.us')) return true; // grupos não passam por onWhatsApp
      const r = await sock.onWhatsApp(jid.split('@')[0]);
      return Array.isArray(r) && r.length > 0 && r[0].exists !== false;
    },
    // Marca o chat como "não lido" no celular (selo visual; mensagens próprias nunca geram push)
    async markUnread(jid, sentMsg) {
      if (!sentMsg || !sentMsg.key) return;
      await sock.chatModify(
        { markRead: false, lastMessages: [{ key: sentMsg.key, messageTimestamp: sentMsg.messageTimestamp }] },
        jid
      );
    },
  };
}

module.exports = { extractContent, extractAnexo, startWhatsApp };

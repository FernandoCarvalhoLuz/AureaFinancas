const test = require('node:test');
const assert = require('node:assert/strict');
const { extractContent } = require('../src/whatsapp');

test('extrai texto simples', () => {
  assert.deepEqual(extractContent({ message: { conversation: 'oi' } }), { text: 'oi' });
});

test('extrai texto estendido (reply/link)', () => {
  assert.deepEqual(extractContent({ message: { extendedTextMessage: { text: 'dentista amanhã' } } }), { text: 'dentista amanhã' });
});

test('identifica áudio com mimetype', () => {
  assert.deepEqual(
    extractContent({ message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } } }),
    { audio: { mimeType: 'audio/ogg; codecs=opus' } }
  );
});

test('mensagens sem conteúdo útil viram null', () => {
  assert.equal(extractContent({ message: { imageMessage: {} } }), null);
  assert.equal(extractContent({}), null);
});

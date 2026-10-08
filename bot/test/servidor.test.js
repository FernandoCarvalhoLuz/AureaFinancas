const test = require('node:test');
const assert = require('node:assert/strict');
const { criarVerificador } = require('../src/autorizacao');
const { criarServidorHttp } = require('../src/servidor-http');

test('autorização: próprio número sempre pode; outros só se autorizados', () => {
  const pode = criarVerificador('55 (21) 99999-8888, 5511988887777');
  assert.equal(pode({ deMim: true }), true);
  assert.equal(pode({ remetente: '5521999998888@s.whatsapp.net' }), true);
  assert.equal(pode({ remetente: '5511988887777:12@s.whatsapp.net' }), true, 'ignora o sufixo de aparelho');
  assert.equal(pode({ remetente: '5521000000000@s.whatsapp.net' }), false);
  assert.equal(pode({ remetente: null }), false);
  assert.equal(criarVerificador('')({ remetente: '5521999998888@s.whatsapp.net' }), false, 'lista vazia: só o próprio bot');
});

async function subir(opcoes) {
  const app = criarServidorHttp({ token: 'k'.repeat(30), getStatus: () => 'waiting_qr', getQr: () => 'conteudo-do-qr', ...opcoes });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

test('http: /health é aberto; /status exige a chave e devolve o QR como imagem', async () => {
  const { srv, url } = await subir({});
  try {
    assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true, whatsapp: 'waiting_qr' });
    assert.equal((await fetch(`${url}/status`)).status, 401);
    assert.equal((await fetch(`${url}/status`, { headers: { 'x-api-token': 'errada' } })).status, 401);
    const s = await (await fetch(`${url}/status`, { headers: { 'x-api-token': 'k'.repeat(30) } })).json();
    assert.equal(s.whatsapp, 'waiting_qr');
    assert.match(s.qr, /^data:image\/png;base64,/);
  } finally {
    srv.close();
  }
});

test('http: conectado não expõe QR', async () => {
  const { srv, url } = await subir({ getStatus: () => 'connected' });
  try {
    const s = await (await fetch(`${url}/status`, { headers: { 'x-api-token': 'k'.repeat(30) } })).json();
    assert.deepEqual(s, { whatsapp: 'connected', qr: null });
  } finally {
    srv.close();
  }
});

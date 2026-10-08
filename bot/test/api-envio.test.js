const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { criarRotasEnvio, normalizarNumero } = require('../src/api-envio');

// ---------- normalização de número ----------

test('normalizarNumero: celular com DDD vira JID brasileiro', () => {
  assert.equal(normalizarNumero('21999998888'), '5521999998888@s.whatsapp.net');
});

test('normalizarNumero: aceita máscara, espaços e +55', () => {
  assert.equal(normalizarNumero('+55 (21) 99999-8888'), '5521999998888@s.whatsapp.net');
  assert.equal(normalizarNumero('55 21 99999 8888'), '5521999998888@s.whatsapp.net');
});

test('normalizarNumero: fixo de 10 dígitos também recebe 55', () => {
  assert.equal(normalizarNumero('2129998888'), '552129998888@s.whatsapp.net');
});

test('normalizarNumero: JID já pronto é preservado', () => {
  assert.equal(normalizarNumero('5521999998888@s.whatsapp.net'), '5521999998888@s.whatsapp.net');
  assert.equal(normalizarNumero('120363000000000000@g.us'), '120363000000000000@g.us');
});

test('normalizarNumero: entradas inválidas viram null', () => {
  assert.equal(normalizarNumero('123'), null);
  assert.equal(normalizarNumero(''), null);
  assert.equal(normalizarNumero(null), null);
  assert.equal(normalizarNumero('abc'), null);
});

// ---------- endpoint ----------

function subirApi({ token = 'segredo', status = 'connected', existe = true, enviar, atrasoEnvioMs = 0, audiosDisponiveis = ['cobranca'] } = {}) {
  const enviados = [];
  const audiosEnviados = [];
  const estado = { emExecucao: 0, sobreposicoes: 0 };
  const wa = {
    getStatus: () => status,
    send: async (jid, texto) => {
      estado.emExecucao += 1;
      if (estado.emExecucao > 1) estado.sobreposicoes += 1;
      if (atrasoEnvioMs) await new Promise((r) => setTimeout(r, atrasoEnvioMs));
      enviados.push({ jid, texto });
      estado.emExecucao -= 1;
      if (enviar === 'erro') throw new Error('falha no envio');
      return { key: { id: 'x' } };
    },
    verificarNumero: async () => existe,
    sendAudio: async (jid, caminho) => {
      audiosEnviados.push({ jid, caminho });
      return { key: { id: 'a' } };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', criarRotasEnvio({
    wa,
    token,
    log: { info() {}, warn() {}, error() {} },
    intervaloMs: 0,
    audioExiste: (nome) => audiosDisponiveis.includes(nome),
    caminhoAudio: (nome) => `/media/${nome}.ogg`,
  }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () =>
      resolve({ server, enviados, audiosEnviados, estado, url: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

const post = (url, body, headers = {}) =>
  fetch(`${url}/api/enviar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('envia quando token, número e texto estão corretos', async () => {
  const { server, enviados, url } = await subirApi();
  try {
    const r = await post(url, { numero: '21999998888', texto: 'Olá!' }, { 'x-api-token': 'segredo' });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.sucesso, true);
    assert.deepEqual(enviados, [{ jid: '5521999998888@s.whatsapp.net', texto: 'Olá!' }]);
  } finally {
    server.close();
  }
});

test('sem token ou com token errado: 401 e nada é enviado', async () => {
  const { server, enviados, url } = await subirApi();
  try {
    assert.equal((await post(url, { numero: '21999998888', texto: 'oi' })).status, 401);
    assert.equal((await post(url, { numero: '21999998888', texto: 'oi' }, { 'x-api-token': 'errado' })).status, 401);
    assert.equal(enviados.length, 0);
  } finally {
    server.close();
  }
});

test('token não configurado no servidor: endpoint desligado (503)', async () => {
  const { server, url } = await subirApi({ token: '' });
  try {
    const r = await post(url, { numero: '21999998888', texto: 'oi' }, { 'x-api-token': 'qualquer' });
    assert.equal(r.status, 503);
  } finally {
    server.close();
  }
});

test('campos faltando ou número inválido: 400', async () => {
  const { server, enviados, url } = await subirApi();
  try {
    assert.equal((await post(url, { texto: 'oi' }, { 'x-api-token': 'segredo' })).status, 400);
    assert.equal((await post(url, { numero: '21999998888' }, { 'x-api-token': 'segredo' })).status, 400);
    assert.equal((await post(url, { numero: '123', texto: 'oi' }, { 'x-api-token': 'segredo' })).status, 400);
    assert.equal(enviados.length, 0);
  } finally {
    server.close();
  }
});

test('whatsapp desconectado: 503 e nada é enviado', async () => {
  const { server, enviados, url } = await subirApi({ status: 'disconnected' });
  try {
    const r = await post(url, { numero: '21999998888', texto: 'oi' }, { 'x-api-token': 'segredo' });
    assert.equal(r.status, 503);
    assert.equal(enviados.length, 0);
  } finally {
    server.close();
  }
});

test('número que não tem WhatsApp: 404 e nada é enviado', async () => {
  const { server, enviados, url } = await subirApi({ existe: false });
  try {
    const r = await post(url, { numero: '21999998888', texto: 'oi' }, { 'x-api-token': 'segredo' });
    assert.equal(r.status, 404);
    assert.match((await r.json()).erro, /WhatsApp/i);
    assert.equal(enviados.length, 0);
  } finally {
    server.close();
  }
});

test('falha no envio devolve 500 com mensagem', async () => {
  const { server, url } = await subirApi({ enviar: 'erro' });
  try {
    const r = await post(url, { numero: '21999998888', texto: 'oi' }, { 'x-api-token': 'segredo' });
    assert.equal(r.status, 500);
    assert.ok((await r.json()).erro);
  } finally {
    server.close();
  }
});

// ---------- envio com áudio ----------

test('com audio válido: envia o texto e depois o áudio', async () => {
  const { server, enviados, audiosEnviados, url } = await subirApi();
  try {
    const r = await post(url, { numero: '21999998888', texto: 'Oi', audio: 'cobranca' }, { 'x-api-token': 'segredo' });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.sucesso, true);
    assert.equal(body.audioEnviado, true);
    assert.equal(enviados.length, 1);
    assert.deepEqual(audiosEnviados, [{ jid: '5521999998888@s.whatsapp.net', caminho: '/media/cobranca.ogg' }]);
  } finally {
    server.close();
  }
});

test('sem audio: comportamento antigo, nenhum áudio enviado', async () => {
  const { server, enviados, audiosEnviados, url } = await subirApi();
  try {
    const r = await post(url, { numero: '21999998888', texto: 'Oi' }, { 'x-api-token': 'segredo' });
    assert.equal((await r.json()).audioEnviado, false);
    assert.equal(enviados.length, 1);
    assert.equal(audiosEnviados.length, 0);
  } finally {
    server.close();
  }
});

test('audio inexistente: 400 e nada é enviado', async () => {
  const { server, enviados, audiosEnviados, url } = await subirApi();
  try {
    const r = await post(url, { numero: '21999998888', texto: 'Oi', audio: 'naoexiste' }, { 'x-api-token': 'segredo' });
    assert.equal(r.status, 400);
    assert.equal(enviados.length, 0);
    assert.equal(audiosEnviados.length, 0);
  } finally {
    server.close();
  }
});

test('nome de áudio com caminho malicioso é recusado (400)', async () => {
  const { server, enviados, audiosEnviados, url } = await subirApi();
  try {
    for (const nome of ['../../etc/passwd', 'a/b', 'audio.ogg', '..']) {
      const r = await post(url, { numero: '21999998888', texto: 'Oi', audio: nome }, { 'x-api-token': 'segredo' });
      assert.equal(r.status, 400, `deveria recusar: ${nome}`);
    }
    assert.equal(enviados.length, 0);
    assert.equal(audiosEnviados.length, 0);
  } finally {
    server.close();
  }
});

test('falha ao enviar o áudio não invalida o texto já entregue', async () => {
  const { server, enviados, url } = await subirApi();
  try {
    const r = await fetch(`${url}/api/enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-token': 'segredo' },
      body: JSON.stringify({ numero: '21999998888', texto: 'Oi', audio: 'cobranca' }),
    });
    assert.equal(r.status, 200);
    assert.equal(enviados.length, 1);
  } finally {
    server.close();
  }
});

test('preflight CORS responde e libera o header do token', async () => {
  const { server, url } = await subirApi();
  try {
    const r = await fetch(`${url}/api/enviar`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://financas.exemplo.com.br:8080',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-api-token',
      },
    });
    assert.ok(r.status === 204 || r.status === 200);
    assert.ok(r.headers.get('access-control-allow-origin'));
    assert.match(r.headers.get('access-control-allow-headers') || '', /x-api-token/i);
  } finally {
    server.close();
  }
});

test('envios concorrentes nunca se sobrepõem (fila serial)', async () => {
  // atraso no envio garante que, sem fila, as chamadas se sobreporiam
  const { server, enviados, estado, url } = await subirApi({ atrasoEnvioMs: 25 });
  try {
    const respostas = await Promise.all([
      post(url, { numero: '21999998881', texto: 'a' }, { 'x-api-token': 'segredo' }),
      post(url, { numero: '21999998882', texto: 'b' }, { 'x-api-token': 'segredo' }),
      post(url, { numero: '21999998883', texto: 'c' }, { 'x-api-token': 'segredo' }),
    ]);
    respostas.forEach((r) => assert.equal(r.status, 200));
    assert.equal(enviados.length, 3);
    assert.equal(estado.sobreposicoes, 0, 'envios simultâneos detectados — a fila não serializou');
    assert.deepEqual([...new Set(enviados.map((e) => e.texto))].sort(), ['a', 'b', 'c']);
  } finally {
    server.close();
  }
});

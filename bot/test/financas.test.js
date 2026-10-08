// Configuração da instalação de teste: o dono se chama Carlos (antes de carregar os módulos).
process.env.NOMES_EU = 'Carlos,Eu';
process.env.ANO_BASE = '2026';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const ia = require('../src/financas-ia');
const { criarAgenteFinancas, RE_OK, RE_CANCELAR } = require('../src/financas-agente');
const { criarRotasFinancas } = require('../src/api-financas');
const { extractAnexo } = require('../src/whatsapp');
const { createAiGemini } = require('../src/ai-gemini');
const { createAiOpenAI } = require('../src/ai-openai');
const { criarComFallback } = require('../src/ai-fallback');

const FATURAS = [
  { id: 1, banco: 'SANTANDER', mes: 'Setembro', pessoas: [{ nome: 'Carlos', valor: 10, status: 'ok' }] },
  { id: 2, banco: 'Aluguel', mes: 'Outubro', pessoas: [
    { nome: 'Carlos', valor: 780, status: 'pendente' },
    { nome: 'Ana', valor: 780, status: 'pendente' },
  ] },
  { id: 3, banco: 'SANTANDER', mes: 'Outubro', pessoas: [] },
  { id: 4, banco: 'MERCADO LIVRE', mes: 'Outubro', pessoas: [{ nome: 'Bruno', valor: 10, status: 'pendente' }] },
];
const CTX = ia.montarContexto(FATURAS);

function lanc(extra = {}) {
  return {
    mes: 'Outubro', banco: 'santander', pessoas: ['carlos'], valor: 32.5, tipoValor: 'unico',
    descricao: 'Uber', parcelamento: 'a_vista', totalParcelas: 0, parcelaAtual: 0, ...extra,
  };
}

// ---------- contexto ----------

test('contexto: meses em ordem, mês atual e pessoas sem repetir', () => {
  assert.deepEqual(CTX.meses, ['Setembro', 'Outubro']);
  assert.equal(CTX.mesAtual, 'Outubro');
  assert.deepEqual(CTX.contasPorMes.Outubro, ['Aluguel', 'SANTANDER', 'MERCADO LIVRE']);
  assert.ok(CTX.pessoas.includes('Ana') && CTX.pessoas.includes('Bruno'));
  assert.equal(CTX.pessoas.filter((p) => ia.norm(p) === 'carlos').length, 1);
});

test('contexto: pendências do mês atual ignoram o próprio usuário', () => {
  assert.deepEqual(CTX.pendencias.map((p) => p.nome), ['Ana', 'Bruno']);
});

test('contexto: "Janeiro 2027" vem depois de "Dezembro"', () => {
  const c = ia.montarContexto([{ mes: 'Janeiro 2027', banco: 'x' }, { mes: 'Dezembro', banco: 'x' }]);
  assert.deepEqual(c.meses, ['Dezembro', 'Janeiro 2027']);
});

// ---------- divisão e normalização ----------

test('dividir: soma exata em centavos, sobra no primeiro', () => {
  assert.deepEqual(ia.dividir(100.01, 2), [50.01, 50]);
  assert.deepEqual(ia.dividir(10, 3), [3.34, 3.33, 3.33]);
});

test('normalizar: lançamento completo casa conta e pessoa com os nomes reais', () => {
  const n = ia.normalizarLancamento(lanc(), CTX);
  assert.deepEqual(n.faltas, []);
  assert.equal(n.banco, 'SANTANDER');
  assert.equal(n.contaNova, false);
  assert.deepEqual(n.itens, [{ nome: 'Carlos', valor: 32.5, pessoaNova: false }]);
  assert.equal(n.totalParcelas, null);
});

test('normalizar: parcelamento não informado é falta (nunca assume à vista)', () => {
  const n = ia.normalizarLancamento(lanc({ parcelamento: 'nao_informado' }), CTX);
  assert.ok(n.faltas.includes('se é à vista ou parcelado'));
});

test('normalizar: compra parcelada pelo total vira valor da parcela, dividido entre pessoas', () => {
  const n = ia.normalizarLancamento(lanc({
    valor: 300, tipoValor: 'total_da_compra', parcelamento: 'parcelado', totalParcelas: 3, pessoas: ['Carlos', 'ana'],
  }), CTX);
  assert.deepEqual(n.faltas, []);
  assert.equal(n.valorParcela, 100);
  assert.equal(n.parcelaAtual, 1);
  assert.deepEqual(n.itens.map((i) => [i.nome, i.valor]), [['Carlos', 50], ['Ana', 50]]);
});

test('normalizar: parcelado sem número de parcelas pede a quantidade', () => {
  const n = ia.normalizarLancamento(lanc({ parcelamento: 'parcelado', totalParcelas: 0 }), CTX);
  assert.ok(n.faltas.includes('em quantas parcelas'));
});

test('normalizar: mês "buraco" no passado, conta e pessoa vazias viram faltas', () => {
  const n = ia.normalizarLancamento(lanc({ mes: 'Agosto', banco: '', pessoas: [], valor: 0 }), CTX);
  assert.equal(n.faltas.length, 4);
  assert.match(n.faltas[0], /Agosto não existe na plataforma e fica antes de Outubro/);
});

test('resolverMes: existente, próximos (com os do meio), virada de ano e limites', () => {
  assert.deepEqual(ia.resolverMes('outubro', CTX), { mes: 'Outubro', criar: [] });
  assert.deepEqual(ia.resolverMes('Novembro', CTX), { mes: 'Novembro', criar: ['Novembro'] });
  assert.deepEqual(ia.resolverMes('dezembro', CTX), { mes: 'Dezembro', criar: ['Novembro', 'Dezembro'] });
  assert.deepEqual(ia.resolverMes('Janeiro de 2027', CTX), { mes: 'Janeiro 2027', criar: ['Novembro', 'Dezembro', 'Janeiro 2027'] });
  assert.deepEqual(ia.resolverMes('jan/27', CTX).mes, 'Janeiro 2027');
  assert.deepEqual(ia.resolverMes('janeiro', CTX).mes, 'Janeiro 2027', 'janeiro sem ano = o próximo janeiro');
  assert.match(ia.resolverMes('fevereiro 2027', CTX).erro, /longe demais; posso criar no máximo até Janeiro 2027/);
  assert.match(ia.resolverMes('agosto', CTX).erro, /fica antes/);
  assert.match(ia.resolverMes('xyz', CTX).erro, /não entendi/);
});

test('normalizar: mês novo herda as contas do mais recente e o resumo avisa a criação', () => {
  const n = ia.normalizarLancamento(lanc({ mes: 'Novembro' }), CTX);
  assert.deepEqual(n.faltas, []);
  assert.deepEqual(n.mesesNovos, ['Novembro']);
  assert.equal(n.banco, 'SANTANDER');
  assert.equal(n.contaNova, false);
  const r = ia.resumoConfirmacao([n], CTX);
  assert.match(r, /🆕 Vou criar o mês \*Novembro\*, com as contas de Outubro/);
  assert.deepEqual(ia.mesesNovosDe([n, ia.normalizarLancamento(lanc({ mes: 'Dezembro' }), CTX)]), ['Novembro', 'Dezembro']);
});

test('agente: lançar em mês novo manda os meses a criar junto e avisa que criou', async () => {
  const enviados = [];
  let recebido;
  const agente = criarAgenteFinancas({
    ai: { gerarJson: async () => ({ intencao: 'lancar', resposta: '', lancamentos: [lanc({ mes: 'Dezembro' })] }) },
    api: { faturas: async () => FATURAS, lancar: async (g, meses) => { recebido = { g, meses }; return { resumo: [], mesesCriados: meses }; } },
    send: async (j, t) => enviados.push(t),
  });
  await agente.handleMessage({ chatJid: 'g', isGroup: true, text: 'uber 32,50 santander à vista em dezembro' });
  assert.match(enviados.at(-1), /Vou criar os meses \*Novembro, Dezembro\*/);
  await agente.handleMessage({ chatJid: 'g', isGroup: true, text: 'ok' });
  assert.deepEqual(recebido.meses, ['Novembro', 'Dezembro']);
  assert.equal(recebido.g[0].mes, 'Dezembro');
  assert.match(enviados.at(-1), /🗓️ Meses criados: Novembro, Dezembro\.\n✅ Lançado!/);
});

test('normalizar: conta e pessoa novas ficam sinalizadas', () => {
  const n = ia.normalizarLancamento(lanc({ banco: 'Nubank', pessoas: ['Carla'] }), CTX);
  assert.equal(n.contaNova, true);
  assert.equal(n.itens[0].pessoaNova, true);
});

test('normalizar: nome repetido com grafia diferente não duplica', () => {
  const n = ia.normalizarLancamento(lanc({ pessoas: ['Carlos', 'CARLOS'] }), CTX);
  assert.equal(n.itens.length, 1);
});

test('resumo e payload: o texto mostra exatamente o que vai para a API', () => {
  const ns = [
    ia.normalizarLancamento(lanc(), CTX),
    ia.normalizarLancamento(lanc({ banco: 'Nubank', descricao: 'Fone', valor: 90, parcelamento: 'parcelado', totalParcelas: 3, tipoValor: 'parcela' }), CTX),
  ];
  const r = ia.resumoConfirmacao(ns);
  assert.match(r, /\*1\. SANTANDER\* · Outubro/);
  assert.match(r, /Nubank\* \(conta nova\)/);
  assert.match(r, /parcela 1\/3/);
  assert.match(r, /Responda \*OK\*/);
  const api = ia.paraApi(ns);
  assert.equal(api.length, 2);
  assert.deepEqual(api[1].itens[0], {
    nome: 'Carlos', valor: 90, descricao: 'Fone', parcelaAtual: 1, totalParcelas: 3, status: 'pendente', origem: 'whatsapp',
  });
});

test('fatura: normaliza parcelas, valores negativos e descarta linhas sem valor', () => {
  const f = ia.normalizarFatura({
    banco: 'Santander', totalFatura: -500,
    itens: [
      { data: '02/09', descricao: 'LOJA X', valor: 75.2, parcelaAtual: 2, totalParcelas: 3, credito: false },
      { data: '', descricao: 'ESTORNO', valor: -20, parcelaAtual: 0, totalParcelas: 0, credito: true },
      { data: '', descricao: 'ZERO', valor: 0, parcelaAtual: 0, totalParcelas: 0, credito: false },
    ],
  });
  assert.equal(f.totalFatura, 500);
  assert.equal(f.itens.length, 2);
  assert.deepEqual([f.itens[0].parcelaAtual, f.itens[0].totalParcelas], [2, 3]);
  assert.deepEqual([f.itens[1].valor, f.itens[1].credito, f.itens[1].totalParcelas], [20, true, null]);
});

// ---------- agente ----------

function cenario(saidas) {
  const fila = [...saidas];
  const enviados = [];
  const lancados = [];
  const chamadasIa = [];
  const ai = {
    gerarJson: async (args) => {
      chamadasIa.push(args);
      const s = fila.shift();
      if (!s) throw new Error('IA chamada mais vezes que o esperado');
      return s;
    },
  };
  const api = {
    faturas: async () => FATURAS,
    lancar: async (grupos) => { lancados.push(grupos); return { revisao: 7, resumo: grupos.map((g) => ({ ...g, itens: g.itens.length })) }; },
  };
  const agente = criarAgenteFinancas({ ai, api, send: async (jid, t) => enviados.push(t), urlPagina: 'http://x' });
  const falar = (text, extra = {}) => agente.handleMessage({ chatJid: 'g@g.us', isGroup: true, text, ...extra });
  return { falar, enviados, lancados, chamadasIa };
}

test('agente: pergunta o que falta, mostra o resumo e só grava depois do OK', async () => {
  const c = cenario([
    { intencao: 'lancar', resposta: 'Foi à vista ou parcelado?', lancamentos: [lanc({ parcelamento: 'nao_informado' })] },
    { intencao: 'lancar', resposta: '', lancamentos: [lanc()] },
  ]);
  await c.falar('uber 32,50 no santander, eu');
  assert.equal(c.enviados.at(-1), 'Foi à vista ou parcelado?');
  assert.equal(c.lancados.length, 0);

  await c.falar('à vista');
  assert.match(c.enviados.at(-1), /Confere o lançamento/);
  assert.equal(c.lancados.length, 0);
  // o histórico da conversa vai para a IA na segunda volta
  assert.equal(c.chamadasIa[1].mensagens.length, 3);

  await c.falar('OK');
  assert.equal(c.chamadasIa.length, 2, 'o OK não passa pela IA');
  assert.equal(c.lancados.length, 1);
  assert.deepEqual(c.lancados[0][0].itens[0].nome, 'Carlos');
  assert.match(c.enviados.at(-1), /✅ Lançado! 1 item em SANTANDER · Outubro/);
});

test('agente: "OK" sem resumo pendente não grava nada', async () => {
  const c = cenario([{ intencao: 'conversar', resposta: 'Manda o gasto!', lancamentos: [] }]);
  await c.falar('ok');
  assert.equal(c.lancados.length, 0);
  assert.equal(c.enviados.at(-1), 'Manda o gasto!');
});

test('agente: "não" é resposta, não cancelamento', async () => {
  assert.equal(RE_CANCELAR.test('não'), false);
  assert.equal(RE_CANCELAR.test('cancela'), true);
  assert.equal(RE_OK.test('Ok!'), true);
  assert.equal(RE_OK.test('ok mas muda pra 4x'), false);
});

test('agente: cancelar descarta o resumo e o OK seguinte não grava', async () => {
  const c = cenario([
    { intencao: 'lancar', resposta: '', lancamentos: [lanc()] },
    { intencao: 'conversar', resposta: 'Beleza.', lancamentos: [] },
  ]);
  await c.falar('uber 32,50 santander à vista');
  await c.falar('cancela');
  assert.match(c.enviados.at(-1), /Cancelado/);
  await c.falar('ok');
  assert.equal(c.lancados.length, 0);
});

test('agente: correção depois do resumo gera resumo novo, e o OK grava a versão corrigida', async () => {
  const c = cenario([
    { intencao: 'lancar', resposta: '', lancamentos: [lanc()] },
    { intencao: 'lancar', resposta: '', lancamentos: [lanc({ valor: 40 })] },
  ]);
  await c.falar('uber 32,50 santander à vista');
  await c.falar('na verdade foi 40');
  await c.falar('ok');
  assert.equal(c.lancados[0][0].itens[0].valor, 40);
});

test('agente: se a IA não pergunta, a pergunta do código vai junto', async () => {
  const c = cenario([{ intencao: 'lancar', resposta: 'Anotei o Uber.', lancamentos: [lanc({ banco: '' })] }]);
  await c.falar('uber 32,50 à vista');
  assert.match(c.enviados.at(-1), /Anotei o Uber\.\nPra lançar, me diz a conta/);
});

test('agente: anexo e autor chegam na IA', async () => {
  const c = cenario([{ intencao: 'lancar', resposta: 'Quem paga?', lancamentos: [lanc({ pessoas: [] })] }]);
  await c.falar('', { anexo: { buffer: Buffer.from('x'), mimeType: 'image/jpeg' }, autor: 'Ana' });
  assert.equal(c.chamadasIa[0].anexos.length, 1);
  assert.match(c.chamadasIa[0].mensagens.at(-1).content, /^\[Ana\] \(documento\/imagem anexado\)/);
});

test('agente: falha ao gravar mantém o rascunho para tentar de novo', async () => {
  const c = cenario([{ intencao: 'lancar', resposta: '', lancamentos: [lanc()] }]);
  let tentativas = 0;
  const agente = criarAgenteFinancas({
    ai: { gerarJson: async () => ({ intencao: 'lancar', resposta: '', lancamentos: [lanc()] }) },
    api: { faturas: async () => FATURAS, lancar: async () => { tentativas += 1; if (tentativas === 1) throw new Error('offline'); return { resumo: [] }; } },
    send: async (j, t) => c.enviados.push(t),
  });
  const m = (text) => agente.handleMessage({ chatJid: 'g', isGroup: true, text });
  await m('uber');
  await m('ok');
  assert.match(c.enviados.at(-1), /Não consegui gravar: offline/);
  await m('ok');
  assert.equal(tentativas, 2);
  assert.match(c.enviados.at(-1), /✅ Lançado/);
});

// ---------- endpoint de leitura de fatura ----------

async function subir(ai) {
  const app = express();
  app.use('/api/financas', criarRotasFinancas({ ai, token: 'segredo', log: { info() {}, error() {} } }));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/api/financas/extrair`;
  const post = (corpo, token = 'segredo') => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': token }, body: JSON.stringify(corpo) });
  return { srv, post };
}

test('extrair: exige token, valida tipo e devolve itens', async () => {
  const ai = { gerarJson: async ({ anexos }) => ({ banco: 'Inter', totalFatura: 50, itens: [{ data: '01/10', descricao: `ANEXOS ${anexos.length}`, valor: 50, parcelaAtual: 0, totalParcelas: 0, credito: false }] }) };
  const { srv, post } = await subir(ai);
  try {
    assert.equal((await post({ texto: 'x' }, 'errado')).status, 401);
    assert.equal((await post({ arquivo: { base64: 'eA==', mimeType: 'text/html' } })).status, 400);
    assert.equal((await post({})).status, 400);
    const r = await post({ arquivo: { base64: Buffer.from('%PDF').toString('base64'), mimeType: 'application/pdf' } });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.fatura.itens[0].descricao, 'ANEXOS 1');
  } finally {
    srv.close();
  }
});

// ---------- WhatsApp e store ----------

test('extractAnexo: foto com legenda, PDF dentro de documentWithCaption e texto puro', () => {
  assert.deepEqual(extractAnexo({ message: { imageMessage: { mimetype: 'image/jpeg', caption: 'mercado', fileLength: 10 } } }),
    { mimeType: 'image/jpeg', caption: 'mercado', tamanho: 10 });
  assert.equal(extractAnexo({ message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf' } } } } }).mimeType, 'application/pdf');
  assert.equal(extractAnexo({ message: { conversation: 'oi' } }), null);
});

test('store: vincula, troca e desvincula o grupo de finanças', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const antes = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    delete require.cache[require.resolve('../src/store')];
    const store = require('../src/store');
    assert.equal(store.getFinanceGroup(), process.env.FINANCAS_GROUP_ID || null);
    store.setFinanceGroup('fin@g.us');
    assert.equal(store.getFinanceGroup(), 'fin@g.us');
    store.setFinanceGroup('outro@g.us');
    assert.equal(store.getFinanceGroup(), 'outro@g.us');
    store.setFinanceGroup(null);
    assert.equal(store.getFinanceGroup(), process.env.FINANCAS_GROUP_ID || null);
  } finally {
    if (antes === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = antes;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- motores de IA: gerarJson ----------

test('gemini.gerarJson: anexo vira inlineData antes do texto e o JSON volta parseado', async () => {
  let corpo;
  const gem = createAiGemini({
    apiKey: 'k', esperar: async () => {},
    fetch: async (url, op) => { corpo = JSON.parse(op.body); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'STOP' }] }) }; },
  });
  const r = await gem.gerarJson({ systemInstruction: 's', mensagens: [{ role: 'user', content: 'lê' }], anexos: [{ buffer: Buffer.from('img'), mimeType: 'image/png' }], schema: { type: 'object' } });
  assert.deepEqual(r, { a: 1 });
  assert.equal(corpo.contents[0].parts[0].inlineData.mimeType, 'image/png');
  assert.equal(corpo.contents[0].parts[1].text, 'lê');
});

test('openai.gerarJson: imagem vira image_url e PDF vira file', async () => {
  let corpo;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, op) => { corpo = JSON.parse(op.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"b":2}' } }] }) }; };
  try {
    const oa = createAiOpenAI({ apiKey: 'k' });
    const r = await oa.gerarJson({
      systemInstruction: 's', mensagens: [{ role: 'user', content: 'lê' }],
      anexos: [{ buffer: Buffer.from('i'), mimeType: 'image/jpeg' }, { buffer: Buffer.from('p'), mimeType: 'application/pdf' }],
      schema: { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
    });
    assert.deepEqual(r, { b: 2 });
    const partes = corpo.messages[1].content;
    assert.deepEqual(partes.map((p) => p.type), ['text', 'image_url', 'file']);
    assert.equal(corpo.response_format.json_schema.strict, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('fallback: gerarJson cai para o reserva quando o principal falha', async () => {
  const ai = criarComFallback({
    principal: { nome: 'p', gerarJson: async () => { throw new Error('503'); } },
    reserva: { nome: 'r', gerarJson: async () => ({ ok: true }) },
  });
  assert.deepEqual(await ai.gerarJson({}), { ok: true });
});

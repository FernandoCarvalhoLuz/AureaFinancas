const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { criarApp, validarConfig } = require('../server');

const SENHA = 'senha-de-teste-123';
const CHAVE = 'c'.repeat(32);

async function subir(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurea-'));
  const c = { porta: 0, dataDir, senha: SENHA, chaveInterna: CHAVE, botUrl: '', nomesEu: ['Carlos', 'Eu'], anoBase: 2026, proxyConfiavel: false, sessaoDias: 30, ...extra };
  const { app, pronto, db } = criarApp(c);
  await pronto;
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const req = async (caminho, { metodo = 'GET', corpo, headers = {}, comCookie = true } = {}) => {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(comCookie && cookie ? { cookie } : {}), ...headers },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, corpo: await r.json().catch(() => null), headers: r.headers };
  };
  const bot = (caminho, opcoes = {}) => req(caminho, { ...opcoes, comCookie: false, headers: { 'x-api-key': CHAVE } });
  const entrar = () => req('/api/login', { metodo: 'POST', corpo: { senha: SENHA } });
  const fechar = () => new Promise((r) => { srv.close(); db.close(() => { fs.rmSync(dataDir, { recursive: true, force: true }); r(); }); });
  return { base, req, bot, entrar, fechar, dataDir };
}

test('config: recusa senha curta, chave curta e bot sem chave', () => {
  assert.equal(validarConfig({ senha: '123', chaveInterna: '', botUrl: '', anoBase: 2026 }).length, 1);
  assert.equal(validarConfig({ senha: 'senhaboa1', chaveInterna: 'curta', botUrl: 'http://bot', anoBase: 2026 }).length, 1);
  assert.equal(validarConfig({ senha: 'senhaboa1', chaveInterna: '', botUrl: 'http://bot', anoBase: 2026 }).length, 1);
  assert.deepEqual(validarConfig({ senha: 'senhaboa1', chaveInterna: CHAVE, botUrl: 'http://bot', anoBase: 2026 }), []);
});

test('acesso: página é pública, dados e banco não', async () => {
  const s = await subir();
  try {
    const pag = await fetch(s.base + '/');
    assert.equal(pag.status, 200);
    const html = await pag.text();
    assert.match(html, /<title>/);
    assert.match(pag.headers.get('content-security-policy') || '', /script-src 'self' https:\/\/cdnjs\.cloudflare\.com;/);
    assert.equal(pag.headers.get('x-frame-options'), 'DENY');
    assert.doesNotMatch(html, /<script>/, 'nenhum script inline (a CSP bloquearia)');
    assert.doesNotMatch(html, /\son[a-z]+=["']/, 'nenhum handler inline (onclick=...)');
    for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https:[^"]+\.(?:js|css))"[^>]*>/g)) {
      assert.match(m[0], /integrity="sha384-/, `${m[1]} precisa de SRI`);
    }
    assert.equal(pag.headers.get('strict-transport-security'), null, 'HSTS só sob HTTPS');
    for (const p of ['/financas.db', '/data/financas.db', '/../data/financas.db', '/server.js', '/package.json']) {
      assert.notEqual((await fetch(s.base + p)).status, 200, `${p} não pode ser servido`);
    }
    assert.ok(fs.existsSync(path.join(s.dataDir, 'financas.db')), 'o banco existe, só não é servido');
    assert.equal((await s.req('/api/financas')).status, 401);
    assert.equal((await s.req('/api/financas', { headers: { 'x-api-key': 'errada' } })).status, 401);
    assert.equal((await s.req('/api/financas', { headers: { apikey: 'chave-fixa-antiga' } })).status, 401, 'cabeçalho antigo (apikey) não dá acesso');
  } finally { await s.fechar(); }
});

test('login: senha errada, certa (cookie HttpOnly), config, logout', async () => {
  const s = await subir();
  try {
    assert.equal((await s.req('/api/login', { metodo: 'POST', corpo: { senha: 'errada' } })).status, 401);
    const r = await s.entrar();
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const cfg = await s.req('/api/config');
    assert.deepEqual(cfg.corpo, { nomesEu: ['Carlos', 'Eu'], anoBase: 2026, whatsapp: false });
    assert.equal((await s.req('/api/financas')).status, 200);
    await s.req('/api/logout', { metodo: 'POST' });
    assert.equal((await s.req('/api/financas')).status, 401, 'depois de sair, o cookie não vale');
  } finally { await s.fechar(); }
});

test('login: trocar a APP_SENHA derruba as sessões abertas', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurea-'));
  const c = { dataDir, senha: SENHA, chaveInterna: CHAVE, botUrl: '', nomesEu: ['Eu'], anoBase: 2026, sessaoDias: 30 };
  const subirCom = async (senha) => {
    const { app, pronto, db } = criarApp({ ...c, senha });
    await pronto;
    const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    return { url: `http://127.0.0.1:${srv.address().port}`, fechar: () => new Promise((r) => { srv.close(); db.close(r); }) };
  };
  let a = await subirCom(SENHA);
  const login = await fetch(`${a.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: SENHA }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await a.fechar();
  a = await subirCom(SENHA);
  assert.equal((await fetch(`${a.url}/api/financas`, { headers: { cookie } })).status, 200, 'reiniciar com a mesma senha mantém a sessão');
  await a.fechar();
  a = await subirCom('outra-senha-forte');
  assert.equal((await fetch(`${a.url}/api/financas`, { headers: { cookie } })).status, 401, 'senha nova: sessão antiga caiu');
  await a.fechar();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('login: trava depois de 8 erros', async () => {
  const s = await subir();
  try {
    for (let i = 0; i < 8; i += 1) await s.req('/api/login', { metodo: 'POST', corpo: { senha: 'x' } });
    assert.equal((await s.req('/api/login', { metodo: 'POST', corpo: { senha: 'x' } })).status, 429);
    assert.equal((await s.entrar()).status, 429, 'nem a senha certa entra durante o bloqueio');
  } finally { await s.fechar(); }
});

test('dados: revisão e 409 quando o bot gravou antes', async () => {
  const s = await subir();
  try {
    await s.entrar();
    const salvo = await s.req('/api/financas', { metodo: 'POST', corpo: [{ id: 1, banco: 'Nubank', mes: 'Setembro', pessoas: [] }], headers: { 'X-Revisao-Base': '0' } });
    assert.deepEqual(salvo.corpo, { success: true, revisao: 1 });
    const bot = await s.bot('/api/lancamentos', { metodo: 'POST', corpo: { lancamentos: [{ mes: 'Setembro', banco: 'nubank', itens: [{ nome: 'Ana', valor: 10 }] }] } });
    assert.equal(bot.status, 200);
    const velho = await s.req('/api/financas', { metodo: 'POST', corpo: [], headers: { 'X-Revisao-Base': '1' } });
    assert.equal(velho.status, 409, 'a página não pode apagar o que o bot acabou de lançar');
    const atual = await s.req('/api/financas');
    assert.equal(atual.headers.get('x-revisao'), '2');
    assert.equal(atual.corpo[0].pessoas[0].nome, 'Ana');
  } finally { await s.fechar(); }
});

test('lançamentos do bot: cria meses em ordem (como o "Novo mês"), recusa pular, tudo ou nada', async () => {
  const s = await subir();
  try {
    await s.entrar();
    await s.req('/api/financas', { metodo: 'POST', corpo: [
      { id: 1, banco: 'Cartão', mes: 'Setembro', pessoas: [
        { nome: 'Carlos', valor: 50, parcelaAtual: 2, totalParcelas: 3, status: 'ok', descricao: 'tv' },
        { nome: 'Carlos', valor: 30, parcelaAtual: 3, totalParcelas: 3, status: 'ok', descricao: 'acabou' },
      ] },
      { id: 2, banco: 'Aluguel', mes: 'Setembro', pessoas: [{ nome: 'Ana', valor: 700, status: 'ok' }] },
    ] });
    const pular = await s.bot('/api/lancamentos', { metodo: 'POST', corpo: { mesesNovos: ['Novembro'], lancamentos: [{ mes: 'Novembro', banco: 'X', itens: [{ nome: 'Ana', valor: 1 }] }] } });
    assert.equal(pular.status, 400);
    assert.match(pular.corpo.error, /mês seguinte ao mais recente \(Outubro\)/);
    assert.equal((await s.req('/api/financas')).corpo.length, 2, 'nada foi criado');

    const ok = await s.bot('/api/lancamentos', { metodo: 'POST', corpo: { mesesNovos: ['Novembro', 'Outubro'], lancamentos: [{ mes: 'Novembro', banco: 'Pix', itens: [{ nome: 'Ana', valor: 12.345, totalParcelas: 1 }] }] } });
    assert.deepEqual(ok.corpo.mesesCriados, ['Outubro', 'Novembro']);
    const d = (await s.req('/api/financas')).corpo;
    const out = d.find((f) => f.mes === 'Outubro' && f.banco === 'Cartão').pessoas;
    assert.deepEqual(out.map((p) => [p.descricao, p.parcelaAtual, p.status]), [['tv', 3, 'pendente']], 'avança parcela e tira a que acabou');
    assert.equal(d.find((f) => f.mes === 'Outubro' && f.banco === 'Aluguel').pessoas[0].status, 'pendente', 'repete o fixo como pendente');
    const pix = d.find((f) => f.mes === 'Novembro' && f.banco === 'Pix').pessoas[0];
    assert.deepEqual([pix.valor, pix.totalParcelas, pix.origem], [12.35, null, undefined]);
    assert.ok(d.some((f) => f.mes === 'Novembro' && f.banco === 'Conta de Luz'), 'contas fixas garantidas');
  } finally { await s.fechar(); }
});

test('cobranças: grava e lista', async () => {
  const s = await subir();
  try {
    await s.entrar();
    assert.equal((await s.req('/api/cobrancas', { metodo: 'POST', corpo: { nome: 'Ana' } })).status, 400);
    const c = await s.req('/api/cobrancas', { metodo: 'POST', corpo: { nome: 'Âna ', meses: ['Setembro'], total: 10.005, canal: 'web' } });
    assert.deepEqual([c.corpo.pessoa, c.corpo.nome, c.corpo.total, c.corpo.canal], ['ana', 'Âna', 10.01, 'web']);
    assert.equal((await s.req('/api/cobrancas')).corpo.length, 1);
  } finally { await s.fechar(); }
});

test('ponte com o bot: repassa com a chave interna; sem bot responde 503', async () => {
  const recebidos = [];
  const falso = express();
  falso.use(express.json());
  falso.post('/api/enviar', (req, res) => { recebidos.push({ token: req.get('x-api-token'), corpo: req.body }); res.json({ sucesso: true }); });
  falso.get('/status', (req, res) => res.json({ whatsapp: 'connected', qr: null }));
  const fsrv = await new Promise((r) => { const x = falso.listen(0, () => r(x)); });
  const s = await subir({ botUrl: `http://127.0.0.1:${fsrv.address().port}` });
  const sem = await subir();
  try {
    await s.entrar();
    assert.equal((await s.req('/api/config')).corpo.whatsapp, true);
    const r = await s.req('/api/whatsapp/enviar', { metodo: 'POST', corpo: { numero: '21999998888', texto: 'oi' } });
    assert.deepEqual(r.corpo, { sucesso: true });
    assert.deepEqual(recebidos[0], { token: CHAVE, corpo: { numero: '21999998888', texto: 'oi' } });
    assert.equal((await s.req('/api/whatsapp/status')).corpo.whatsapp, 'connected');
    assert.equal((await s.req('/api/whatsapp/enviar', { metodo: 'POST', corpo: {}, comCookie: false })).status, 401, 'sem login não envia');
    await sem.entrar();
    assert.equal((await sem.req('/api/whatsapp/enviar', { metodo: 'POST', corpo: {} })).status, 503);
  } finally {
    await s.fechar(); await sem.fechar(); fsrv.close();
  }
});

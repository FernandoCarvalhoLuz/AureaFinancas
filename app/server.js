// Áurea · servidor do app de finanças
// - Serve a página (somente a pasta public/) e os dados (SQLite em DATA_DIR).
// - Acesso à API: sessão por senha (navegador) ou CHAVE_INTERNA (bot do WhatsApp).
// - Fala com o bot pela rede interna: o navegador nunca vê a chave nem a porta do bot.
//
// Duas fontes escrevem nos dados: a página (que regrava tudo) e o bot (que só acrescenta).
// Toda gravação incrementa uma revisão; a página manda a revisão em que se baseou e recebe
// 409 se o bot gravou nesse meio-tempo, em vez de apagar o que ele fez.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3');

// ---------- Configuração ----------
const cfg = {
    porta: Number(process.env.PORT || 8080),
    dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
    senha: process.env.APP_SENHA || '',
    chaveInterna: process.env.CHAVE_INTERNA || '',
    botUrl: (process.env.BOT_URL || '').replace(/\/+$/, ''),
    nomesEu: String(process.env.NOMES_EU || 'Eu').split(',').map(s => s.trim()).filter(Boolean),
    anoBase: Number(process.env.ANO_BASE || 2026),
    proxyConfiavel: process.env.PROXY_CONFIAVEL === '1',
    sessaoDias: Number(process.env.SESSAO_DIAS || 30),
};

function validarConfig(c) {
    const erros = [];
    if (c.senha.length < 8) erros.push('APP_SENHA precisa ter pelo menos 8 caracteres.');
    if (c.chaveInterna && c.chaveInterna.length < 24) erros.push('CHAVE_INTERNA precisa ter pelo menos 24 caracteres (use: openssl rand -hex 24).');
    if (c.botUrl && !c.chaveInterna) erros.push('BOT_URL definido sem CHAVE_INTERNA.');
    if (!Number.isInteger(c.anoBase) || c.anoBase < 2000) erros.push('ANO_BASE inválido.');
    return erros;
}

// ---------- Utilitários ----------
const normalizar = s => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function igual(a, b) {
    const x = Buffer.from(hash(a)), y = Buffer.from(hash(b));
    return crypto.timingSafeEqual(x, y);
}
const erro = (status, msg) => Object.assign(new Error(msg), { status });

// ---------- Meses ("Agosto" sem ano = ANO_BASE; a página usa a mesma regra) ----------
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const FIXAS = ['Aluguel', 'Conta de Luz', 'Conta de Internet'];

function criarApp(c = cfg) {
    fs.mkdirSync(c.dataDir, { recursive: true });
    const db = new sqlite3.Database(path.join(c.dataDir, 'financas.db'));
    const run = (sql, p = []) => new Promise((ok, falha) => db.run(sql, p, function (e) { e ? falha(e) : ok(this); }));
    const all = (sql, p = []) => new Promise((ok, falha) => db.all(sql, p, (e, r) => e ? falha(e) : ok(r)));
    const get = (sql, p = []) => new Promise((ok, falha) => db.get(sql, p, (e, r) => e ? falha(e) : ok(r)));

    const infoMes = rotulo => {
        const [nome, ano] = String(rotulo ?? '').trim().split(/\s+/);
        const idx = MESES.indexOf(nome);
        const a = /^\d{4}$/.test(ano || '') ? Number(ano) : c.anoBase;
        return { idx, ordem: idx < 0 ? 1e9 : a * 12 + idx };
    };
    const rotuloDe = (idx, ano) => (ano === c.anoBase ? MESES[idx] : `${MESES[idx]} ${ano}`);
    const somarMeses = (rotulo, n) => { const t = infoMes(rotulo).ordem + n; return rotuloDe(((t % 12) + 12) % 12, Math.floor(t / 12)); };

    // Uma gravação por vez: transações intercaladas na mesma conexão se atropelariam.
    let fila = Promise.resolve();
    const exclusivo = tarefa => { const r = fila.then(tarefa, tarefa); fila = r.catch(() => {}); return r; };
    async function transacao(fn) {
        return exclusivo(async () => {
            await run('BEGIN');
            try { const r = await fn(); await run('COMMIT'); return r; }
            catch (e) { await run('ROLLBACK').catch(() => {}); await lerRevisao(); throw e; }
        });
    }

    let revisao = 0;
    async function lerRevisao() { const r = await get("SELECT valor FROM meta WHERE chave = 'revisao'"); revisao = r ? Number(r.valor) || 0 : 0; }
    async function novaRevisao() { revisao += 1; await run("INSERT OR REPLACE INTO meta (chave, valor) VALUES ('revisao', ?)", [String(revisao)]); return revisao; }

    const pronto = (async () => {
        await run('PRAGMA journal_mode = WAL');
        await run('CREATE TABLE IF NOT EXISTS faturas (id TEXT PRIMARY KEY, banco TEXT, mes TEXT, descricao TEXT, pessoas TEXT)');
        await run('CREATE TABLE IF NOT EXISTS meta (chave TEXT PRIMARY KEY, valor TEXT)');
        await run('CREATE TABLE IF NOT EXISTS cobrancas (id INTEGER PRIMARY KEY AUTOINCREMENT, pessoa TEXT, nome TEXT, meses TEXT, total REAL, canal TEXT, criadoEm TEXT)');
        await run('CREATE TABLE IF NOT EXISTS sessoes (token TEXT PRIMARY KEY, expira INTEGER)');
        await run('DELETE FROM sessoes WHERE expira < ?', [Date.now()]);
        // Trocou a APP_SENHA? Todas as sessões abertas com a senha antiga caem.
        const senhaAtual = hash(`senha:${c.senha}`);
        const anterior = await get("SELECT valor FROM meta WHERE chave = 'senha'");
        if (anterior && anterior.valor !== senhaAtual) await run('DELETE FROM sessoes');
        await run("INSERT OR REPLACE INTO meta (chave, valor) VALUES ('senha', ?)", [senhaAtual]);
        await lerRevisao();
    })();

    const paraFatura = r => ({ id: isNaN(r.id) ? r.id : Number(r.id), banco: r.banco, mes: r.mes, descricao: r.descricao, pessoas: JSON.parse(r.pessoas || '[]') });

    // ---------- App ----------
    const app = express();
    app.disable('x-powered-by');
    if (c.proxyConfiavel) app.set('trust proxy', 1);
    app.use(express.json({ limit: '25mb' }));
    app.use((req, res, next) => {
        res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
        next();
    });

    // Só a pasta public/ é servida. O banco fica em DATA_DIR, fora do alcance do navegador.
    app.use(express.static(path.join(__dirname, 'public'), {
        setHeaders: (res, f) => { if (/\.(html|js|css)$/.test(f)) res.set('Cache-Control', 'no-cache'); },
    }));

    // ---------- Sessão ----------
    const COOKIE = 'aurea_sessao';
    function lerCookie(req) {
        const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
        return m ? m[1] : null;
    }
    async function sessaoValida(req) {
        const t = lerCookie(req);
        if (!t) return false;
        const r = await get('SELECT expira FROM sessoes WHERE token = ?', [hash(t)]);
        return Boolean(r && r.expira > Date.now());
    }

    // Freio contra força bruta: 8 tentativas erradas por IP a cada 15 minutos.
    const tentativas = new Map();
    function bloqueado(ip) {
        const t = tentativas.get(ip);
        if (!t || Date.now() - t.inicio > 15 * 60e3) return false;
        return t.erros >= 8;
    }
    function errou(ip) {
        const t = tentativas.get(ip);
        if (!t || Date.now() - t.inicio > 15 * 60e3) tentativas.set(ip, { inicio: Date.now(), erros: 1 });
        else t.erros += 1;
    }

    app.post('/api/login', async (req, res) => {
        await pronto;
        if (bloqueado(req.ip)) return res.status(429).json({ error: 'Muitas tentativas. Espere 15 minutos.' });
        const senha = String((req.body && req.body.senha) || '');
        if (!c.senha || !igual(senha, c.senha)) {
            errou(req.ip);
            return res.status(401).json({ error: 'Senha incorreta.' });
        }
        tentativas.delete(req.ip);
        const token = crypto.randomBytes(32).toString('hex');
        const expira = Date.now() + c.sessaoDias * 864e5;
        await run('INSERT INTO sessoes (token, expira) VALUES (?, ?)', [hash(token), expira]);
        const seguro = req.secure ? '; Secure' : '';
        res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${c.sessaoDias * 86400}${seguro}`);
        res.json({ ok: true });
    });

    app.post('/api/logout', async (req, res) => {
        const t = lerCookie(req);
        if (t) await run('DELETE FROM sessoes WHERE token = ?', [hash(t)]);
        res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
        res.json({ ok: true });
    });

    // Tudo em /api daqui para baixo exige sessão (página) ou a chave interna (bot).
    app.use('/api', async (req, res, next) => {
        try {
            await pronto;
            const chave = req.get('x-api-key');
            if (chave && c.chaveInterna && igual(chave, c.chaveInterna)) { req.origem = 'bot'; return next(); }
            if (await sessaoValida(req)) { req.origem = 'pagina'; return next(); }
            res.status(401).json({ error: 'Faça login.' });
        } catch (e) { next(e); }
    });

    app.get('/api/config', (req, res) => {
        res.json({ nomesEu: c.nomesEu, anoBase: c.anoBase, whatsapp: Boolean(c.botUrl) });
    });

    // ---------- Dados ----------
    app.get('/api/revisao', (req, res) => res.json({ revisao }));

    app.get('/api/financas', async (req, res, next) => {
        try {
            const rows = await all('SELECT id, banco, mes, descricao, pessoas FROM faturas');
            res.set('X-Revisao', String(revisao)).json(rows.map(paraFatura));
        } catch (e) { next(e); }
    });

    app.post('/api/financas', async (req, res, next) => {
        const faturas = req.body;
        if (!Array.isArray(faturas)) return res.status(400).json({ error: 'Formato de faturas inválido.' });
        const base = req.get('X-Revisao-Base');
        try {
            const r = await exclusivo(async () => {
                if (base !== undefined && Number(base) !== revisao) return { conflito: true };
                await run('BEGIN');
                try {
                    await run('DELETE FROM faturas');
                    for (const f of faturas) {
                        await run('INSERT INTO faturas (id, banco, mes, descricao, pessoas) VALUES (?, ?, ?, ?, ?)',
                            [String(f.id), f.banco || '', f.mes || '', f.descricao || '', JSON.stringify(f.pessoas || [])]);
                    }
                    const nova = await novaRevisao();
                    await run('COMMIT');
                    return { revisao: nova };
                } catch (e) { await run('ROLLBACK').catch(() => {}); await lerRevisao(); throw e; }
            });
            if (r.conflito) return res.status(409).json({ error: 'Os dados mudaram no servidor desde a última leitura.', revisao });
            res.set('X-Revisao', String(r.revisao)).json({ success: true, revisao: r.revisao });
        } catch (e) { next(e); }
    });

    function limparItem(i) {
        const valor = Math.round(Number(i && i.valor) * 100) / 100;
        if (!i || !i.nome || typeof i.nome !== 'string' || !(valor > 0)) return null;
        const inteiro = v => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
        let parcelaAtual = inteiro(i.parcelaAtual);
        let totalParcelas = inteiro(i.totalParcelas);
        if (!totalParcelas || totalParcelas < 2) { parcelaAtual = null; totalParcelas = null; }
        else if (!parcelaAtual || parcelaAtual > totalParcelas) parcelaAtual = parcelaAtual > totalParcelas ? totalParcelas : 1;
        const item = {
            nome: i.nome.trim(), valor, parcelaAtual, totalParcelas,
            descricao: typeof i.descricao === 'string' ? i.descricao.trim() : '',
            status: i.status === 'ok' ? 'ok' : 'pendente',
        };
        if (i.origem) item.origem = String(i.origem).slice(0, 30);
        item.criadoEm = new Date().toISOString();
        return item;
    }

    // Cria o mês seguinte ao mais recente, como o "Novo mês" da página (opções padrão):
    // leva todas as contas, avança parcelas, repete valores sem parcela e tira as que acabaram.
    async function criarMesSeguinte(alvo) {
        if (infoMes(alvo).idx < 0) throw erro(400, `Mês inválido: "${alvo}".`);
        const rows = await all('SELECT id, banco, mes, descricao, pessoas FROM faturas');
        const meses = [...new Set(rows.map(r => r.mes))].sort((a, b) => infoMes(a).ordem - infoMes(b).ordem);
        if (meses.includes(alvo)) return false;
        const ultimo = meses[meses.length - 1];
        if (ultimo && somarMeses(ultimo, 1) !== alvo) throw erro(400, `Só dá para criar o mês seguinte ao mais recente (${somarMeses(ultimo, 1)}), não ${alvo}.`);
        const origem = ultimo ? rows.filter(r => r.mes === ultimo) : [];
        const base = Date.now();
        for (const [n, r] of origem.entries()) {
            const novos = [];
            for (const p of JSON.parse(r.pessoas || '[]')) {
                const parcelado = p.parcelaAtual && p.totalParcelas;
                if (parcelado && +p.parcelaAtual < +p.totalParcelas) novos.push({ ...p, parcelaAtual: +p.parcelaAtual + 1, status: 'pendente' });
                else if (!parcelado) novos.push({ ...p, status: 'pendente' });
            }
            await run('INSERT INTO faturas (id, banco, mes, descricao, pessoas) VALUES (?, ?, ?, ?, ?)',
                [String(base + n + Math.random()), r.banco, alvo, r.descricao || '', JSON.stringify(novos)]);
        }
        for (const banco of FIXAS) {
            if (!origem.some(r => r.banco === banco)) {
                await run('INSERT INTO faturas (id, banco, mes, descricao, pessoas) VALUES (?, ?, ?, ?, ?)', [String(Date.now() + Math.random()), banco, alvo, '', '[]']);
            }
        }
        return true;
    }

    // Acrescenta lançamentos sem regravar o resto (usado pelo bot).
    // { mesesNovos?: [...], lancamentos: [{ mes, banco, itens: [...] }] } — tudo ou nada.
    app.post('/api/lancamentos', async (req, res, next) => {
        const grupos = req.body && req.body.lancamentos;
        const mesesNovos = Array.isArray(req.body && req.body.mesesNovos) ? req.body.mesesNovos.map(String) : [];
        if (!Array.isArray(grupos) || !grupos.length) return res.status(400).json({ error: 'Envie { lancamentos: [...] }.' });
        try {
            for (const g of grupos) {
                if (!g || !g.mes) throw erro(400, 'Mês obrigatório em cada lançamento.');
                if (!g.banco || typeof g.banco !== 'string') throw erro(400, 'Conta (banco) obrigatória.');
                if (!Array.isArray(g.itens) || !g.itens.length || g.itens.some(i => !limparItem(i))) throw erro(400, `Itens inválidos para ${g.banco}.`);
            }
            const r = await transacao(async () => {
                const criados = [];
                for (const m of mesesNovos.slice().sort((a, b) => infoMes(a).ordem - infoMes(b).ordem)) {
                    if (await criarMesSeguinte(m)) criados.push(m);
                }
                const meses = new Set((await all('SELECT DISTINCT mes FROM faturas')).map(x => x.mes));
                const resumo = [];
                for (const g of grupos) {
                    if (!meses.has(g.mes)) throw erro(400, `Mês "${g.mes}" não existe. Crie o mês na página primeiro.`);
                    const doMes = await all('SELECT id, banco, pessoas FROM faturas WHERE mes = ?', [g.mes]);
                    const existente = doMes.find(x => normalizar(x.banco) === normalizar(g.banco));
                    const itens = g.itens.map(limparItem);
                    if (existente) {
                        await run('UPDATE faturas SET pessoas = ? WHERE id = ?', [JSON.stringify(JSON.parse(existente.pessoas || '[]').concat(itens)), existente.id]);
                        resumo.push({ mes: g.mes, banco: existente.banco, itens: itens.length, contaNova: false });
                    } else {
                        await run('INSERT INTO faturas (id, banco, mes, descricao, pessoas) VALUES (?, ?, ?, ?, ?)',
                            [String(Date.now() + Math.random()), g.banco.trim(), g.mes, '', JSON.stringify(itens)]);
                        resumo.push({ mes: g.mes, banco: g.banco.trim(), itens: itens.length, contaNova: true });
                    }
                }
                return { revisao: await novaRevisao(), resumo, mesesCriados: criados };
            });
            res.json({ success: true, ...r });
        } catch (e) { next(e); }
    });

    // ---------- Cobranças enviadas ("cobrado 2x") ----------
    const paraCobranca = r => ({ id: r.id, pessoa: r.pessoa, nome: r.nome, meses: JSON.parse(r.meses || '[]'), total: r.total, canal: r.canal, criadoEm: r.criadoEm });
    app.get('/api/cobrancas', async (req, res, next) => {
        try { res.json((await all('SELECT * FROM cobrancas ORDER BY id DESC LIMIT 1000')).map(paraCobranca)); } catch (e) { next(e); }
    });
    app.post('/api/cobrancas', async (req, res, next) => {
        const { nome, meses, total, canal } = req.body || {};
        if (!nome || typeof nome !== 'string' || !Array.isArray(meses) || !meses.length) return res.status(400).json({ error: 'Envie { nome, meses: [...], total, canal }.' });
        try {
            const r = await exclusivo(async () => {
                const ins = await run('INSERT INTO cobrancas (pessoa, nome, meses, total, canal, criadoEm) VALUES (?, ?, ?, ?, ?, ?)', [
                    normalizar(nome), nome.trim(), JSON.stringify(meses.map(String).slice(0, 24)),
                    Math.round(Number(total || 0) * 100) / 100, ['bot', 'web'].includes(canal) ? canal : 'bot', new Date().toISOString(),
                ]);
                return get('SELECT * FROM cobrancas WHERE id = ?', [ins.lastID]);
            });
            res.json(paraCobranca(r));
        } catch (e) { next(e); }
    });

    // ---------- Ponte com o bot (rede interna) ----------
    async function bot(caminho, { metodo = 'GET', corpo, timeoutMs = 120000 } = {}) {
        if (!c.botUrl) throw erro(503, 'WhatsApp não configurado nesta instalação.');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await fetch(`${c.botUrl}${caminho}`, {
                method: metodo,
                headers: { 'Content-Type': 'application/json', 'x-api-token': c.chaveInterna },
                body: corpo ? JSON.stringify(corpo) : undefined,
                signal: ctrl.signal,
            });
            return { status: r.status, corpo: await r.json().catch(() => ({})) };
        } catch (e) {
            throw erro(502, 'O bot do WhatsApp não está respondendo.');
        } finally { clearTimeout(timer); }
    }
    const repassar = (caminho, metodo) => async (req, res, next) => {
        try { const r = await bot(caminho, { metodo, corpo: metodo === 'POST' ? req.body : undefined }); res.status(r.status).json(r.corpo); }
        catch (e) { next(e); }
    };
    app.get('/api/whatsapp/status', repassar('/status', 'GET'));
    app.post('/api/whatsapp/enviar', repassar('/api/enviar', 'POST'));
    app.post('/api/fatura/extrair', repassar('/api/financas/extrair', 'POST'));

    // ---------- Erros ----------
    app.use((e, req, res, next) => { // eslint-disable-line no-unused-vars
        if (!e.status) console.error('❌', e);
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro interno no servidor.' });
    });

    return { app, pronto, db };
}

if (require.main === module) {
    const erros = validarConfig(cfg);
    if (erros.length) {
        console.error('⚠️  Configuração inválida:\n - ' + erros.join('\n - ') + '\nConfira o arquivo .env (veja .env.example).');
        process.exit(1);
    }
    const { app, pronto } = criarApp(cfg);
    pronto.then(() => app.listen(cfg.porta, () => {
        console.log(`🚀 Áurea rodando na porta ${cfg.porta} · dados em ${cfg.dataDir} · WhatsApp ${cfg.botUrl ? 'ligado' : 'desligado'}`);
    }));
}

module.exports = { criarApp, validarConfig };

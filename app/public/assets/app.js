/* =====================================================================
   Áurea · Finanças da casa
   Tudo passa pelo próprio servidor que serve esta página: dados (/api/financas),
   WhatsApp (/api/whatsapp/*) e leitura de faturas (/api/fatura/extrair).
   O acesso é por sessão (cookie HttpOnly), aberta com a senha da instalação.
   ===================================================================== */
'use strict';
(() => {

// ---------- Constantes (as de instalação vêm de GET /api/config) ----------
const API_URL = '/api/financas';
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
let ANO_BASE = 2026;                   // meses gravados sem ano ("Agosto") pertencem a este ano (ANO_BASE no .env)
const FIXAS = ['Aluguel', 'Conta de Luz', 'Conta de Internet'];
let EU = ['eu'];                       // nomes que são "minha parte" (NOMES_EU no .env)
let NOME_EU = 'Eu';                    // nome usado quando o lançamento é do dono
let WHATSAPP = false;                  // a instalação tem o bot do WhatsApp?

// ---------- Utilitários ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfCurto = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const brl = v => 'R$ ' + nf.format(v || 0);
const brlCurto = v => 'R$ ' + (Math.abs(v) >= 10000 ? nfCurto.format(v) : nf.format(v || 0).replace(/,00$/, ''));
const rotuloBarra = v => !v ? '—' : v >= 1000 ? nfCurto.format(v) : Math.round(v).toString();
const money = v => `<small>R$</small>${nf.format(v || 0)}`;
const norm = s => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
// Nomes TODO EM CAIXA ALTA viram minúsculas (o CSS capitaliza); siglas curtas como "WL" ficam.
const bonito = s => { s = String(s ?? ''); return s.length > 3 && s === s.toUpperCase() ? s.toLowerCase() : s; };
const ehEu = nome => EU.includes(norm(nome));
const clone = o => JSON.parse(JSON.stringify(o));
const plural = (n, s, p) => `${n} ${n === 1 ? s : (p || s + 's')}`;
const esperar = ms => new Promise(r => setTimeout(r, ms));
const hue = s => { let h = 7; for (const c of norm(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const avatar = (nome, cls = '') =>
    `<span class="av ${cls} ${ehEu(nome) ? 'eu' : ''}" style="--h:${hue(nome)}">${esc((String(nome).trim()[0] || '?'))}</span>`;
const reduzMovimento = () =>
    document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* armazenamento indisponível */ } };

function parseValor(s) {
    s = String(s ?? '').trim().replace(/[R$\s]/g, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const v = parseFloat(s);
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
}

// ---------- Meses ----------
function infoMes(rotulo) {
    const [nome, ano] = String(rotulo ?? '').trim().split(/\s+/);
    const idx = MESES.indexOf(nome);
    const a = /^\d{4}$/.test(ano || '') ? +ano : ANO_BASE;
    return { idx, ano: a, nome: idx < 0 ? String(rotulo) : nome, ordem: idx < 0 ? 1e9 : a * 12 + idx };
}
const rotuloDe = (idx, ano) => ano === ANO_BASE ? MESES[idx] : `${MESES[idx]} ${ano}`;
function somarMeses(rotulo, n) {
    const { idx, ano } = infoMes(rotulo);
    const t = ano * 12 + idx + n;
    return rotuloDe(((t % 12) + 12) % 12, Math.floor(t / 12));
}
const mesesOrdenados = () => [...new Set(state.dados.map(f => f.mes))].sort((a, b) => infoMes(a).ordem - infoMes(b).ordem);
function mesAnterior(rotulo) { const ms = mesesOrdenados(); const i = ms.indexOf(rotulo); return i > 0 ? ms[i - 1] : null; }
const abrev = rotulo => infoMes(rotulo).nome.slice(0, 3);

// ---------- Estado ----------
const state = {
    dados: [],
    mes: null,
    busca: '',
    filtro: 'todas',
    escopo: 'mes',
    telefones: {},
    contaAberta: null,
    pessoaAberta: null,
    online: false,
    cobrancas: [],   // histórico de cobranças enviadas (servidor), mais recentes primeiro
    revisao: null,   // revisão do servidor em que os dados locais se baseiam
    carga: 0,        // muda a cada recarga vinda do servidor (invalida "Desfazer" e saves na fila)
};
let ANIM = true;

// ---------- Acesso aos dados ----------
const itens = f => (f.pessoas ||= []);
const faturasDo = mes => state.dados.filter(f => f.mes === mes);
const acharFatura = id => state.dados.find(f => String(f.id) === String(id));
const temParcela = p => !!(p.parcelaAtual && p.totalParcelas);
const continua = p => temParcela(p) && +p.parcelaAtual < +p.totalParcelas;
const pago = p => p.status === 'ok';
const soma = arr => arr.reduce((s, p) => s + (+p.valor || 0), 0);
const faturasEscopo = () => state.escopo === 'mes' ? faturasDo(state.mes) : state.dados;

function ehCasa(banco) {
    const n = norm(banco);
    return FIXAS.some(x => norm(x) === n) || /aluguel|luz|energia|internet|agua|condominio|gas\b/.test(n);
}
function iconeConta(banco) {
    const n = norm(banco);
    if (/aluguel|condominio/.test(n)) return 'bi-house-door';
    if (/luz|energia/.test(n)) return 'bi-lightning-charge';
    if (/internet|wifi|fibra/.test(n)) return 'bi-wifi';
    if (/agua/.test(n)) return 'bi-droplet';
    if (/youtube/.test(n)) return 'bi-youtube';
    if (/premiere|netflix|spotify|globo|disney|prime|max|stream/.test(n)) return 'bi-play-btn';
    if (/mercado|carrefour|atacad|assai/.test(n)) return 'bi-bag';
    if (/picpay|pix/.test(n)) return 'bi-phone';
    return 'bi-credit-card-2-front';
}

// Logos oficiais (assets/logos): Simple Icons (CC0) e Wikimedia Commons (domínio público, marcas registradas).
const LOGOS = [
    [/santander/, 'santander'],
    [/\bitau\b/, 'itau'],
    [/\binter\b/, 'inter'],
    [/mercado ?livre|\bmeli\b/, 'mercadolivre'],
    [/mercado ?pago/, 'mercadopago'],
    [/premiere/, 'premiere'],
    [/nubank|\bnu\b/, 'nubank'],
    [/picpay/, 'picpay'],
    [/carrefour/, 'carrefour'],
    [/youtube/, 'youtube'],
    [/netflix/, 'netflix'],
    [/spotify/, 'spotify'],
    [/ifood/, 'ifood'],
    [/\buber\b/, 'uber'],
    [/\bvivo\b/, 'vivo'],
    [/\bneon\b/, 'neon'],
    [/pagbank|pagseguro/, 'pagseguro'],
    [/shopee/, 'shopee'],
    [/aliexpress/, 'aliexpress'],
    [/\bhbo\b|hbo ?max/, 'hbomax'],
];
function logoConta(banco) {
    const n = norm(banco);
    const m = LOGOS.find(([re]) => re.test(n));
    return m ? `assets/logos/${m[1]}.svg` : null;
}
function icoConta(banco) {
    const l = logoConta(banco);
    return l
        ? `<span class="conta-ico logo"><img src="${l}" alt="" loading="lazy" decoding="async"></span>`
        : `<span class="conta-ico"><i class="bi ${iconeConta(banco)}"></i></span>`;
}

function statsMes(mes) {
    const s = { total: 0, meu: 0, terceiros: 0, receber: 0, pago: 0, itens: 0, contas: 0, parcAtivas: 0, acabando: 0, pessoas: new Set() };
    faturasDo(mes).forEach(f => {
        s.contas++;
        itens(f).forEach(p => {
            const v = +p.valor || 0;
            s.total += v; s.itens++;
            if (pago(p)) s.pago += v;
            if (ehEu(p.nome)) s.meu += v;
            else {
                s.terceiros += v;
                if (!pago(p)) { s.receber += v; s.pessoas.add(norm(p.nome)); }
            }
            if (continua(p)) { s.parcAtivas++; if (p.totalParcelas - p.parcelaAtual <= 2) s.acabando++; }
        });
    });
    s.pct = s.total ? s.pago / s.total : 0;
    return s;
}

function projecao(mes, n = 6) {
    const ativos = faturasDo(mes).flatMap(itens).filter(continua);
    const meses = [];
    for (let k = 1; k <= n; k++) {
        meses.push({ rotulo: somarMeses(mes, k), v: soma(ativos.filter(p => +p.parcelaAtual + k <= +p.totalParcelas)) });
    }
    const maxRest = ativos.reduce((m, p) => Math.max(m, p.totalParcelas - p.parcelaAtual), 0);
    return { meses, ultima: maxRest ? somarMeses(mes, maxRest) : null };
}

function pendentesPorPessoa(faturas) {
    const mapa = new Map();
    faturas.forEach(f => itens(f).forEach(p => {
        if (ehEu(p.nome) || pago(p)) return;
        const k = norm(p.nome);
        if (!mapa.has(k)) mapa.set(k, { k, nome: p.nome, total: 0, qtd: 0, contas: new Set() });
        const o = mapa.get(k);
        o.nome = p.nome; o.total += +p.valor || 0; o.qtd++; o.contas.add(f.banco);
    }));
    return [...mapa.values()].sort((a, b) => b.total - a.total);
}

function nomeDe(k) {
    for (let i = state.dados.length - 1; i >= 0; i--) {
        const p = itens(state.dados[i]).find(x => norm(x.nome) === k);
        if (p) return p.nome;
    }
    return k;
}

function todasPessoas() {
    const m = new Map();
    state.dados.forEach(f => itens(f).forEach(p => m.set(norm(p.nome), p.nome)));
    return [...m.values()];
}

// ---------- Telefones ----------
function telDe(k) {
    const e = Object.entries(state.telefones).find(([n]) => norm(n) === k);
    return e ? e[1] : '';
}
async function salvarTel(k, nome, valor) {
    Object.keys(state.telefones).forEach(n => { if (norm(n) === k) delete state.telefones[n]; });
    const v = String(valor || '').trim();
    if (v) state.telefones[nome] = (v.endsWith('@g.us') || v.endsWith('@c.us')) ? v : v.replace(/\D/g, '');
    try { await localforage.setItem('telefonesPessoas', state.telefones); } catch (e) { console.error(e); }
}

// ---------- Persistência ----------
let filaSalvar = Promise.resolve();
function setSync(s, msg) {
    const el = $('#sync');
    el.dataset.s = s;
    el.title = msg || '';
    el.querySelector('span').textContent = { ok: 'Sincronizado', saving: 'Salvando…', offline: 'Sem conexão', idle: 'Conectando…' }[s];
}
let salvando = 0;
function salvar() {
    setSync('saving');
    const copia = JSON.stringify(state.dados);
    const carga = state.carga;
    salvando++;
    filaSalvar = filaSalvar.then(async () => {
        // Os dados foram recarregados do servidor depois desta alteração: esta cópia está velha.
        if (carga !== state.carga) return;
        try { await localforage.setItem('dadosFinanceiros', JSON.parse(copia)); } catch (e) { console.error(e); }
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (state.revisao !== null) headers['X-Revisao-Base'] = String(state.revisao);
            const r = await fetch(API_URL, { method: 'POST', headers, body: copia });
            if (r.status === 409) return recarregarPorConflito();
            if (r.status === 401) {
                setSync('offline', 'sessão expirada');
                return exigirLogin('Sua sessão expirou. Entre de novo para salvar a última alteração.').then(() => { salvar(); });
            }
            if (!r.ok) throw new Error(`servidor respondeu ${r.status}`);
            const j = await r.json().catch(() => ({}));
            if (Number.isFinite(j.revisao)) state.revisao = j.revisao;
            setSync('ok');
        } catch (e) {
            setSync('offline', e.message);
            toast(`Não consegui salvar no servidor (${e.message}). A alteração ficou guardada neste navegador.`, { tipo: 'bad' });
        }
    }).finally(() => { salvando--; });
    return filaSalvar;
}

async function buscarServidor() {
    const r = await fetch(API_URL, { cache: 'no-store' });
    if (!r.ok) throw Object.assign(new Error(r.status === 401 ? 'chave da API recusada' : `servidor respondeu ${r.status}`), { status: r.status });
    const rev = r.headers.get('X-Revisao');
    return { dados: await r.json(), revisao: rev === null ? null : Number(rev) };
}

function aplicarCarga({ dados, revisao }) {
    state.dados = Array.isArray(dados) ? dados : [];
    state.dados.forEach(f => { f.pessoas = Array.isArray(f.pessoas) ? f.pessoas : []; });
    state.revisao = revisao;
    state.carga++;
    if (!mesesOrdenados().includes(state.mes)) state.mes = mesesOrdenados().at(-1) || null;
    localforage.setItem('dadosFinanceiros', state.dados).catch(() => {});
}

// Outra fonte (o agente do WhatsApp) gravou antes de nós: a versão do servidor vale.
async function recarregarPorConflito() {
    try {
        aplicarCarga(await buscarServidor());
        renderAll(false);
        setSync('ok');
        toast('Chegaram lançamentos novos no servidor (ex.: pelo WhatsApp) e recarreguei a versão atual. Refaça sua última alteração, por favor.', { tipo: 'bad', duracao: 10000 });
    } catch (e) {
        setSync('offline', e.message);
    }
}

// ---------- Cobranças enviadas ("cobrado 2x") ----------
async function carregarCobrancas() {
    try {
        const r = await fetch('/api/cobrancas', { cache: 'no-store' });
        if (r.ok) state.cobrancas = await r.json();
    } catch (e) { /* sem rede: mantém o que tinha */ }
}

/** Meses em que a pessoa tem pendência dentro destas faturas. */
function mesesPendentes(k, faturas) {
    return new Set(faturas.filter(f => itens(f).some(p => norm(p.nome) === k && !pago(p))).map(f => f.mes));
}

/** Cobranças que falam das pendências que a pessoa ainda tem (no escopo do quadro). */
function cobrancasDe(k, faturas = faturasEscopo()) {
    const meses = mesesPendentes(k, faturas);
    return state.cobrancas.filter(c => c.pessoa === k && c.meses.some(m => meses.has(m)));
}

function quando(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const dia = new Date(d); dia.setHours(0, 0, 0, 0);
    const dias = Math.round((hoje - dia) / 864e5);
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (dias <= 0) return `hoje às ${hora}`;
    if (dias === 1) return `ontem às ${hora}`;
    if (dias < 7) return `há ${dias} dias`;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function seloCobrado(k, faturas) {
    const cs = cobrancasDe(k, faturas);
    if (!cs.length) return '';
    return `<span class="cobrado ${cs.length >= 3 ? 'muito' : ''}" title="${esc(cs.map(c => `${new Date(c.criadoEm).toLocaleString('pt-BR')} · ${brl(c.total)} · ${c.canal === 'web' ? 'WhatsApp Web' : 'bot'}`).join('\n'))}"><i class="bi bi-megaphone-fill"></i> Cobrado ${cs.length}x · ${esc(quando(cs[0].criadoEm))}</span>`;
}

async function registrarCobranca(k, faturas, total, canal) {
    const meses = [...mesesPendentes(k, faturas)];
    if (!meses.length) return;
    try {
        const r = await fetch('/api/cobrancas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nomeDe(k), meses, total, canal }),
        });
        if (!r.ok) throw new Error(`servidor respondeu ${r.status}`);
        state.cobrancas.unshift(await r.json());
        renderReceber();
        requestAnimationFrame(() => { posSeg($('#escopo')); $$('#receberCard [data-count]').forEach(contar); });
        if (state.pessoaAberta === k) renderPessoa(false);
    } catch (e) {
        toast(`A mensagem foi, mas não consegui registrar a cobrança (${e.message}).`, { tipo: 'bad' });
    }
}

const totalItens = () => state.dados.reduce((s, f) => s + itens(f).length, 0);
// Busca lançamentos feitos em outro lugar (WhatsApp, outra aba) sem atrapalhar quem está editando.
async function verificarAtualizacoes() {
    if (document.hidden || state.revisao === null || salvando) return;
    try {
        const r = await fetch('/api/revisao', { cache: 'no-store' });
        if (!r.ok) return;
        const { revisao } = await r.json();
        // cobranças feitas em outro aparelho também aparecem
        const qtdCobrancas = state.cobrancas.length;
        await carregarCobrancas();
        if (revisao === state.revisao && state.cobrancas.length !== qtdCobrancas && !salvando) {
            renderReceber();
            requestAnimationFrame(() => posSeg($('#escopo')));
        }
        if (revisao === state.revisao || salvando) return;
        const antes = totalItens();
        const nova = await buscarServidor();
        if (salvando) return;
        aplicarCarga(nova);
        renderAll(false);
        setSync('ok');
        const novos = totalItens() - antes;
        if (novos > 0) toast(`${plural(novos, 'lançamento novo chegou', 'lançamentos novos chegaram')} (WhatsApp ou outra tela).`, { tipo: 'ok' });
    } catch (e) { /* sem rede: tenta na próxima */ }
}

/** Aplica uma alteração, redesenha e salva. Com `desfazer`, oferece voltar atrás. */
function mutar(fn, { desfazer, anim = false } = {}) {
    const antes = desfazer ? clone(state.dados) : null;
    const carga = state.carga;
    fn();
    renderAll(anim);
    salvar();
    if (desfazer) {
        toast(desfazer, {
            acao: 'Desfazer',
            onAcao: () => {
                if (carga !== state.carga) return toast('Não dá mais para desfazer: os dados foram atualizados pelo servidor.', { tipo: 'bad' });
                state.dados = antes;
                if (!mesesOrdenados().includes(state.mes)) state.mes = mesesOrdenados().at(-1) || null;
                renderAll(true);
                salvar();
            }
        });
    }
}

function garantirEspeciais(mes) {
    const alvo = mes ? [mes] : mesesOrdenados();
    let mudou = false;
    alvo.forEach(m => FIXAS.forEach(banco => {
        if (!state.dados.some(f => f.banco === banco && f.mes === m)) {
            state.dados.push({ id: Date.now() + Math.random(), banco, mes: m, descricao: '', pessoas: [] });
            mudou = true;
        }
    }));
    return mudou;
}

// ---------- Login e configuração da instalação ----------
let loginPendente = null;
/** Abre a tela de senha e resolve quando o login der certo. */
function exigirLogin(msg) {
    if (loginPendente) return loginPendente;
    const d = $('#dlgLogin');
    $('#loginMsg').textContent = msg || 'Digite a senha desta instalação.';
    abrir(d);
    setTimeout(() => $('#inSenha').focus(), 60);
    loginPendente = new Promise(res => { d._resolver = res; });
    return loginPendente;
}
async function entrar(e) {
    e.preventDefault();
    const d = $('#dlgLogin');
    const btn = $('#btnEntrar');
    btn.disabled = true;
    try {
        const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: $('#inSenha').value }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { $('#loginMsg').textContent = j.error || 'Não consegui entrar.'; sacudir($('#inSenha')); return; }
        $('#inSenha').value = '';
        fechar(d);
        const res = d._resolver; loginPendente = null; d._resolver = null;
        if (res) res();
    } catch (err) {
        $('#loginMsg').textContent = 'Servidor inacessível. Tente de novo.';
    } finally { btn.disabled = false; }
}

async function carregarConfig() {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.status === 401) return false;
    if (!r.ok) throw Object.assign(new Error(`servidor respondeu ${r.status}`), { status: r.status });
    const c = await r.json();
    if (Array.isArray(c.nomesEu) && c.nomesEu.length) { EU = c.nomesEu.map(norm); NOME_EU = c.nomesEu[0]; }
    if (Number.isInteger(c.anoBase)) ANO_BASE = c.anoBase;
    WHATSAPP = Boolean(c.whatsapp);
    return true;
}

async function carregar() {
    localforage.config({ name: 'AureaFinancas', storeName: 'financas_db', description: 'Cópia local dos dados e preferências' });
    try { state.telefones = (await localforage.getItem('telefonesPessoas')) || {}; } catch (e) { state.telefones = {}; }

    let dados = null, erro = null;
    try {
        if (!(await carregarConfig())) { await exigirLogin(); await carregarConfig(); }
        const c = await buscarServidor();
        aplicarCarga(c);
        dados = state.dados;
        state.online = true;
        setSync('ok');
    } catch (e) {
        erro = e.status ? e.message : 'servidor inacessível';
    }

    if (!dados) {
        setSync('offline', erro);
        try { dados = await localforage.getItem('dadosFinanceiros'); } catch (e) { /* ignora */ }
        if (!dados) { try { const a = localStorage.getItem('dadosFinanceiros'); if (a) dados = JSON.parse(a); } catch (e) { /* ignora */ } }
        toast(dados
            ? `Sem conexão com o servidor (${erro}). Mostrando a cópia salva neste navegador.`
            : `Não foi possível carregar os dados (${erro}).`, { tipo: 'bad', duracao: 9000 });
    }

    state.dados = Array.isArray(dados) ? dados : [];
    state.dados.forEach(f => { f.pessoas = Array.isArray(f.pessoas) ? f.pessoas : []; });
    // Só completa os blocos fixos quando os dados vieram do servidor:
    // nunca sobrescrever o servidor a partir de uma cópia local antiga.
    if (state.online && garantirEspeciais()) salvar();

    state.mes = mesesOrdenados().at(-1) || null;
    if (state.online) await carregarCobrancas();
    renderAll(true);

    setInterval(verificarAtualizacoes, 12000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) verificarAtualizacoes(); });
}

// =====================================================================
//  Renderização
// =====================================================================
function renderAll(anim = false) {
    ANIM = anim && !reduzMovimento();
    renderMeses();
    renderTopo();
    renderKPIs();
    renderContas();
    renderAnalises();
    renderReceber();
    renderQuitando();
    if (state.contaAberta) renderConta(false);
    if (state.pessoaAberta) renderPessoa(false);
    $('#dlPessoas').innerHTML = todasPessoas().map(n => `<option value="${esc(n)}">`).join('');
    requestAnimationFrame(() => {
        $$('[data-count]').forEach(contar);
        $$('[data-w]').forEach(el => { el.style.width = (+el.dataset.w * 100).toFixed(2) + '%'; });
        $$('.ring .val').forEach(c => { c.style.strokeDashoffset = c.dataset.off; });
        $$('.seg').forEach(posSeg);
        moverIndicadorMes();
    });
}
const R = (i = 0) => ANIM ? `rise" style="--i:${i}` : '';

function renderMeses() {
    const ms = mesesOrdenados();
    $('#qtdMeses').textContent = ms.length || '';
    $('#mesesLista').innerHTML = ms.slice().reverse().map(m => {
        const s = statsMes(m);
        const { nome, ano } = infoMes(m);
        const cheio = s.total > 0 && s.pct >= .999;
        return `<button class="mes-btn ${m === state.mes ? 'on' : ''}" data-act="mes" data-mes="${esc(m)}">
            <b>${esc(nome)}<small>${ano}</small></b>
            <span class="mono">${brlCurto(s.total)}</span>
            <span class="mes-prog ${cheio ? 'full' : ''}" style="--p:${s.pct.toFixed(3)}"><i></i></span>
        </button>`;
    }).join('');
}

function moverIndicadorMes() {
    const ind = $('#mesesInd');
    const on = $('.mes-btn.on');
    if (!on) { ind.style.opacity = 0; return; }
    ind.style.height = on.offsetHeight + 'px';
    ind.style.translate = `0 ${on.offsetTop}px`;
    ind.style.opacity = 1;
    if (ANIM) on.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

function posSeg(seg) {
    const on = seg.querySelector('button.on');
    const ind = seg.querySelector('.seg-ind');
    if (!on || !ind) return;
    ind.style.width = on.offsetWidth + 'px';
    ind.style.translate = `${on.offsetLeft - 4}px 0`;
    ind.style.left = '4px';
}

function renderTopo() {
    const ms = mesesOrdenados();
    if (!state.mes) {
        $('#tituloMes').textContent = 'Bem-vindo';
        $('#subMes').textContent = 'Crie o primeiro mês para começar a lançar.';
        return;
    }
    const { nome, ano } = infoMes(state.mes);
    const s = statsMes(state.mes);
    $('#tituloMes').innerHTML = `${esc(nome)}<sup>${ano}</sup>`;
    $('#subMes').textContent = `${plural(s.contas, 'conta')} · ${plural(s.itens, 'lançamento')}` +
        (s.itens ? ` · ${Math.round(s.pct * 100)}% quitado` : '');
    $('#eyebrow').textContent = state.mes === ms.at(-1) ? 'Mês atual' : 'Histórico';
    document.title = `${nome} · Áurea`;
}

function renderKPIs() {
    const el = $('#kpis');
    if (!state.mes) { el.innerHTML = ''; return; }
    const s = statsMes(state.mes);
    const ant = mesAnterior(state.mes);
    const sa = ant ? statsMes(ant) : null;

    let delta = '';
    if (sa && sa.total) {
        const d = (s.total - sa.total) / sa.total;
        const cls = Math.abs(d) < .005 ? 'eq' : d > 0 ? 'up' : 'down';
        const seta = cls === 'up' ? 'up' : cls === 'down' ? 'down' : 'right';
        delta = `<span class="delta ${cls}" title="Comparado a ${esc(ant)}"><i class="bi bi-arrow-${seta}-short"></i>${nf.format(Math.abs(d * 100)).replace(/,?0+$/, '')}% vs ${esc(abrev(ant).toLowerCase())}</span>`;
    }
    const meuP = s.total ? s.meu / s.total : 0;
    const recebido = s.terceiros - s.receber;
    const C = 2 * Math.PI * 28;
    const proj = projecao(state.mes);
    const cheio = s.total > 0 && s.pct >= .999;

    el.innerHTML = `
    <article class="card kpi hero live-border ${R(0)}">
        <span class="ring-live"></span>
        <div class="kpi-l"><i class="bi bi-safe2"></i> Total do mês ${delta}</div>
        <div>
            <div class="kpi-v"><small>R$</small><span data-count="${s.total}" data-key="total">0,00</span></div>
            <div class="split-bar"><i class="me" data-w="${meuP}"></i><i class="them" data-w="${s.total ? 1 - meuP : 0}"></i></div>
        </div>
        <div class="kpi-s">
            <span class="legend"><span style="--c:var(--gold)">Minha parte <b>${brl(s.meu)}</b></span></span>
            <span class="legend"><span style="--c:var(--cool)">Terceiros <b>${brl(s.terceiros)}</b></span></span>
        </div>
    </article>
    <article class="card kpi ${R(1)}">
        <div class="kpi-l"><i class="bi bi-arrow-down-left-circle"></i> A receber</div>
        <div class="kpi-v"><small>R$</small><span data-count="${s.receber}" data-key="receber">0,00</span></div>
        <div class="kpi-s"><span><b>${plural(s.pessoas.size, 'pessoa')}</b> devendo</span><span>${brl(recebido)} já recebido</span></div>
    </article>
    <article class="card kpi ${R(2)}">
        <div class="kpi-l"><i class="bi bi-check2-circle"></i> Quitado</div>
        <div class="ring-wrap">
            <svg class="ring ${cheio ? 'full' : ''}" viewBox="0 0 68 68" aria-hidden="true">
                <circle class="trk" cx="34" cy="34" r="28"/>
                <circle class="val" cx="34" cy="34" r="28" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-off="${C * (1 - s.pct)}"/>
            </svg>
            <div class="ring-pct">${Math.round(s.pct * 100)}%</div>
        </div>
        <div class="kpi-s"><span><b>${brl(s.pago)}</b> pago</span><span>falta <b>${brl(s.total - s.pago)}</b></span></div>
    </article>
    <article class="card kpi ${R(3)}">
        <div class="kpi-l"><i class="bi bi-stack"></i> Parcelamentos</div>
        <div class="kpi-v"><span data-count="${s.parcAtivas}" data-key="parc" data-int="1">0</span><small style="margin-left:6px">ativos</small></div>
        <div class="kpi-s">
            ${s.acabando ? `<span><b>${s.acabando}</b> acabam em até 2 meses</span>` : '<span>Nenhum terminando agora</span>'}
            ${proj.ultima ? `<span>Última parcela em <b>${esc(proj.ultima)}</b></span>` : ''}
        </div>
    </article>`;
}

function filtraConta(f) {
    const its = itens(f);
    if (state.filtro === 'pendentes' && !its.some(p => !pago(p))) return false;
    if (state.filtro === 'parceladas' && !its.some(temParcela)) return false;
    const b = norm(state.busca);
    if (!b) return true;
    return norm(f.banco).includes(b) || norm(f.descricao).includes(b) ||
        its.some(p => norm(p.nome).includes(b) || norm(p.descricao).includes(b));
}

function cardConta(f, i) {
    const its = itens(f);
    const tot = soma(its);
    const pg = soma(its.filter(pago));
    const pend = its.filter(p => !pago(p));
    const quit = its.length > 0 && pend.length === 0;
    const pct = tot ? pg / tot : (quit ? 1 : 0);
    const nomes = [...new Map(its.map(p => [norm(p.nome), p.nome])).values()];
    const parc = its.filter(continua).length;
    const sub = [plural(its.length, 'lançamento'), parc ? `${parc} parcelado${parc > 1 ? 's' : ''}` : '', f.descricao].filter(Boolean).join(' · ');
    const tag = !its.length ? '<span class="tag mute">Vazia</span>'
        : quit ? '<span class="tag ok"><i class="bi bi-check2"></i>Quitada</span>'
        : `<span class="tag pend">${plural(pend.length, 'pendente')}</span>`;
    return `
    <button class="conta fx tilt ${ehCasa(f.banco) ? 'casa' : ''} ${quit ? 'quitada' : ''} ${its.length ? '' : 'vazia'} ${R(i)}" data-act="conta" data-id="${esc(f.id)}">
        <div class="conta-top">
            ${icoConta(f.banco)}
            <div class="conta-n"><h3>${esc(bonito(f.banco))}</h3><p>${esc(sub)}</p></div>
        </div>
        <div class="conta-total">${money(tot)}</div>
        <div class="conta-bar" style="--p:${pct.toFixed(3)}"><i></i></div>
        <div class="conta-foot">
            <div class="avatars">${nomes.slice(0, 4).map(n => avatar(n)).join('')}${nomes.length > 4 ? `<span class="av" style="--h:40">+${nomes.length - 4}</span>` : ''}</div>
            ${tag}
        </div>
    </button>`;
}

function renderContas() {
    const el = $('#contasSec');
    if (!state.mes) {
        el.innerHTML = `<div class="vazio-estado ${R()}"><i class="bi bi-calendar-plus"></i><h3>Nenhum mês ainda</h3>
            <p>Crie o primeiro mês para começar a lançar os custos.</p>
            <button class="btn btn-gold" data-act="novo-mes"><i class="bi bi-plus-lg"></i> Criar mês</button></div>`;
        return;
    }
    const todas = faturasDo(state.mes);
    const vis = todas.filter(filtraConta);
    const ordemFixa = b => { const i = FIXAS.indexOf(b); return i < 0 ? 99 : i; };
    const casa = vis.filter(f => ehCasa(f.banco)).sort((a, b) => ordemFixa(a.banco) - ordemFixa(b.banco));
    const outras = vis.filter(f => !ehCasa(f.banco)).sort((a, b) => soma(itens(b)) - soma(itens(a)));
    const filtrando = state.busca || state.filtro !== 'todas';

    let html = `<div class="sec-h"><h2>Contas <span class="count">${vis.length}${filtrando ? '/' + todas.length : ''}</span></h2></div>`;
    if (!vis.length) {
        html += `<div class="vazio-estado ${R()}"><i class="bi bi-search"></i><h3>Nada por aqui</h3><p>Nenhuma conta corresponde ao filtro.</p></div>`;
    } else {
        let i = 0;
        if (casa.length) html += `<div class="grupo"><div class="grupo-t">Contas da casa</div><div class="contas">${casa.map(f => cardConta(f, i++)).join('')}</div></div>`;
        html += `<div class="grupo"><div class="grupo-t">Cartões e serviços</div><div class="contas">${outras.map(f => cardConta(f, i++)).join('')}
            ${filtrando ? '' : `<button class="conta conta-add ${R(i)}" data-act="conta-nova"><i class="bi bi-plus-lg"></i> Nova conta</button>`}</div></div>`;
    }
    el.innerHTML = html;
}

function renderAnalises() {
    const el = $('#analises');
    if (!state.mes) { el.innerHTML = ''; return; }
    // Evolução: até 6 meses terminando no mês aberto
    const ms = mesesOrdenados();
    const fim = ms.indexOf(state.mes);
    const janela = ms.slice(Math.max(0, fim - 5), fim + 1).map(m => ({ m, s: statsMes(m) }));
    const max = Math.max(1, ...janela.map(x => x.s.total));
    const cols = janela.map((x, i) => `
        <div class="col ${x.m === state.mes ? 'on' : ''}" data-act="mes" data-mes="${esc(x.m)}">
            <div class="tip">${esc(x.m)}<b>${brl(x.s.total)}</b>Minha parte ${brl(x.s.meu)}<br>Terceiros ${brl(x.s.terceiros)}</div>
            <div class="stack" style="--i:${i}">
                <span class="val-top">${rotuloBarra(x.s.total)}</span>
                <i class="them" style="height:${(x.s.terceiros / max * 100).toFixed(2)}%;--i:${i}"></i>
                <i class="me" style="height:${(x.s.meu / max * 100).toFixed(2)}%;--i:${i}"></i>
            </div>
            <span>${esc(abrev(x.m))}</span>
        </div>`).join('');

    // Compromisso futuro: parcelas que já estão contratadas
    const proj = projecao(state.mes);
    const maxF = Math.max(1, ...proj.meses.map(x => x.v));
    const colsF = proj.meses.map((x, i) => `
        <div class="col">
            <div class="tip">${esc(x.rotulo)}<b>${brl(x.v)}</b>já comprometido</div>
            <div class="stack">
                <span class="val-top">${rotuloBarra(x.v)}</span>
                <i class="fut" style="height:${(x.v / maxF * 100).toFixed(2)}%;--i:${i}"></i>
            </div>
            <span>${esc(abrev(x.rotulo))}</span>
        </div>`).join('');

    el.innerHTML = `
    <article class="card ${R(0)}">
        <div class="card-h"><h3><i class="bi bi-bar-chart-line"></i> Evolução</h3>
            <div class="legend"><span style="--c:var(--gold)">Minha parte</span><span style="--c:var(--cool)">Terceiros</span></div></div>
        <div class="card-b"><div class="chart">${cols}</div></div>
    </article>
    <article class="card ${R(1)}">
        <div class="card-h"><h3><i class="bi bi-hourglass-split"></i> Parcelas já contratadas</h3></div>
        <div class="card-b">
            <div class="chart">${colsF}</div>
            <div class="chart-note"><i class="bi bi-flag"></i>${proj.ultima ? `Livre de parcelas depois de <b>${esc(proj.ultima)}</b>` : 'Nenhuma parcela futura'}</div>
        </div>
    </article>`;
}

function renderReceber() {
    const el = $('#receberCard');
    const lista = pendentesPorPessoa(faturasEscopo());
    const total = lista.reduce((s, p) => s + p.total, 0);
    const max = Math.max(1, ...lista.map(p => p.total));
    const rows = lista.map((p, i) => `
        <div class="pessoa ${R(i + 1)}" role="button" tabindex="0" data-act="pessoa" data-k="${esc(p.k)}">
            ${avatar(p.nome, 'lg')}
            <div class="nm"><b>${esc(bonito(p.nome))}</b><small>${plural(p.qtd, 'item', 'itens')} · ${esc([...p.contas].slice(0, 2).map(bonito).join(', '))}${p.contas.size > 2 ? '…' : ''}</small>${seloCobrado(p.k)}</div>
            <div class="vl">
                <b>${brl(p.total)}</b>
                <div class="acts">
                    <button class="icon-btn sm wa" data-act="whats-pessoa" data-k="${esc(p.k)}" title="Cobrar no WhatsApp"><i class="bi bi-whatsapp"></i></button>
                    <button class="icon-btn sm ok" data-act="pessoa-pago" data-k="${esc(p.k)}" title="Marcar tudo como pago"><i class="bi bi-check2-all"></i></button>
                </div>
            </div>
            <span class="bar" style="--p:${(p.total / max).toFixed(3)}"><i></i></span>
        </div>`).join('');

    el.innerHTML = `
        <div class="card-h">
            <h3><i class="bi bi-people"></i> A receber</h3>
            <div class="seg sm" id="escopo">
                <span class="seg-ind"></span>
                <button class="${state.escopo === 'mes' ? 'on' : ''}" data-act="escopo" data-v="mes">Mês</button>
                <button class="${state.escopo === 'tudo' ? 'on' : ''}" data-act="escopo" data-v="tudo">Tudo em aberto</button>
            </div>
        </div>
        <div class="card-b">
            <div class="receber-total"><small class="muted" style="font-size:.5em;margin-right:4px">R$</small><span data-count="${total}" data-key="rail">0,00</span></div>
            <div class="muted" style="font-size:12.5px">${lista.length ? `${plural(lista.length, 'pessoa')} com pendência${state.escopo === 'tudo' ? ' em todos os meses' : ''}` : ''}</div>
            ${lista.length ? `<div class="pessoas">${rows}</div>
                <button class="btn btn-wa btn-block magnet" style="margin-top:14px" data-act="cobrar-todos"><i class="bi bi-whatsapp"></i> Cobrar todos</button>`
            : `<div class="tudo-em-dia"><i class="bi bi-emoji-smile"></i>Ninguém te devendo. Tudo em dia!</div>`}
        </div>`;
}

function renderQuitando() {
    const el = $('#quitandoCard');
    if (!state.mes) { el.innerHTML = ''; return; }
    const lista = faturasDo(state.mes).flatMap(f => itens(f).filter(temParcela).map(p => ({ p, f })))
        .map(x => ({ ...x, rest: x.p.totalParcelas - x.p.parcelaAtual }))
        .filter(x => x.rest >= 0 && x.rest <= 3)
        .sort((a, b) => a.rest - b.rest || b.p.valor - a.p.valor)
        .slice(0, 6);
    const linhas = lista.map(({ p, f, rest }, i) => {
        const tot = Math.min(+p.totalParcelas, 24);
        const feitas = Math.round(+p.parcelaAtual / +p.totalParcelas * tot);
        const seg = Array.from({ length: tot }, (_, j) => `<i class="${j < feitas - 1 ? 'f' : j === feitas - 1 ? (rest === 0 ? 'last' : 'f') : ''}"></i>`).join('');
        return `<div class="quit-item ${R(i + 1)}">
            <b>${esc(bonito(p.descricao || f.banco))} <span class="muted" style="font-weight:400">· ${esc(bonito(p.nome))}</span></b>
            <span class="mono">${p.parcelaAtual}/${p.totalParcelas}</span>
            <div class="trk">${seg}</div>
            <small class="muted">${rest === 0 ? 'Última parcela neste mês 🎉' : `Faltam ${plural(rest, 'parcela')} · ${brl(p.valor)}/mês`}</small>
        </div>`;
    }).join('');
    el.innerHTML = `
        <div class="card-h"><h3><i class="bi bi-flag"></i> Reta final</h3></div>
        <div class="card-b">${lista.length ? `<div class="quitando">${linhas}</div>` : '<div class="muted" style="font-size:13px">Nenhuma parcela perto do fim.</div>'}</div>`;
}

// ---------- Gaveta da conta ----------
function linhaItem(f, p, i) {
    const dots = temParcela(p) && p.totalParcelas <= 12
        ? `<span class="parc-dots">${Array.from({ length: +p.totalParcelas }, (_, j) => `<i class="${j < p.parcelaAtual ? 'f' : ''}"></i>`).join('')}</span>` : '';
    return `
    <div class="item ${pago(p) ? 'pago' : ''}" data-id="${esc(f.id)}" data-i="${i}">
        <button class="check ${pago(p) ? 'on' : ''}" data-act="toggle" data-id="${esc(f.id)}" data-i="${i}" aria-label="${pago(p) ? 'Marcar como pendente' : 'Marcar como pago'}">
            <svg viewBox="0 0 16 16"><path d="M3 8.5l3.2 3L13 4.5"/></svg>
        </button>
        <div class="item-main" data-act="item-editar" data-id="${esc(f.id)}" data-i="${i}">
            <div class="vl">${brl(p.valor)} ${temParcela(p) ? `<span class="parc">${p.parcelaAtual}/${p.totalParcelas} ${dots}</span>` : ''}${p.origem === 'whatsapp' ? '<i class="bi bi-whatsapp origem wa" title="Lançado pelo WhatsApp"></i>' : p.origem === 'fatura' ? '<i class="bi bi-file-earmark-text origem" title="Importado de fatura"></i>' : ''}</div>
            <div class="ds">${p.descricao ? esc(p.descricao) : '<span style="opacity:.6">Sem descrição</span>'}</div>
        </div>
        <div class="item-acts">
            <button class="icon-btn sm" data-act="item-editar" data-id="${esc(f.id)}" data-i="${i}" title="Editar"><i class="bi bi-pencil"></i></button>
            <button class="icon-btn sm bad" data-act="item-remover" data-id="${esc(f.id)}" data-i="${i}" title="Remover"><i class="bi bi-trash3"></i></button>
        </div>
    </div>`;
}

function renderConta(anim = true) {
    const d = $('#dlgConta');
    const f = acharFatura(state.contaAberta);
    if (!f) { fechar(d); return; }
    const a = anim && !reduzMovimento();
    const its = itens(f);
    const tot = soma(its), pg = soma(its.filter(pago));
    const grupos = new Map();
    its.forEach((p, i) => {
        const k = norm(p.nome);
        if (!grupos.has(k)) grupos.set(k, { k, nome: p.nome, linhas: [] });
        grupos.get(k).linhas.push({ p, i });
    });
    const ordem = [...grupos.values()].sort((x, y) => (ehEu(y.nome) - ehEu(x.nome)) || soma(y.linhas.map(l => l.p)) - soma(x.linhas.map(l => l.p)));

    const corpo = ordem.length ? ordem.map((g, gi) => {
        const st = soma(g.linhas.map(l => l.p));
        const pend = g.linhas.filter(l => !pago(l.p));
        return `
        <div class="grupo-pessoa ${a ? 'rise' : ''}" style="--i:${gi}">
            <div class="grupo-pessoa-h">
                ${avatar(g.nome, 'lg')}
                <div class="nm"><b>${esc(bonito(g.nome))}</b><small>${brl(st)} · ${plural(g.linhas.length, 'item', 'itens')}</small></div>
                <div class="acts">
                    ${!ehEu(g.nome) && pend.length ? `<button class="icon-btn wa" data-act="whats-conta" data-id="${esc(f.id)}" data-k="${esc(g.k)}" title="Cobrar no WhatsApp"><i class="bi bi-whatsapp"></i></button>` : ''}
                    ${pend.length ? `<button class="btn btn-ok btn-sm" data-act="pago-conta-pessoa" data-id="${esc(f.id)}" data-k="${esc(g.k)}"><i class="bi bi-check2-all"></i> Tudo pago</button>` : '<span class="tag ok"><i class="bi bi-check2"></i>Pago</span>'}
                </div>
            </div>
            ${g.linhas.map(l => linhaItem(f, l.p, l.i)).join('')}
        </div>`;
    }).join('') : `<div class="vazio-estado"><i class="bi bi-receipt"></i><h3>Sem lançamentos</h3><p>Adicione o primeiro gasto desta conta.</p></div>`;

    d.innerHTML = `
        <div class="drawer-h">
            <div class="row">
                ${icoConta(f.banco)}
                <div style="flex:1;min-width:0">
                    <div class="muted">${esc(f.mes)}${f.descricao ? ' · ' + esc(f.descricao) : ''}</div>
                    <h2>${esc(bonito(f.banco))}</h2>
                </div>
                <button class="icon-btn" data-act="conta-excluir" data-id="${esc(f.id)}" title="Excluir conta deste mês"><i class="bi bi-trash3"></i></button>
                <button class="icon-btn" data-act="fechar" title="Fechar"><i class="bi bi-x-lg"></i></button>
            </div>
            <div class="drawer-stats">
                <div><small>Total</small><b>${brl(tot)}</b></div>
                <div><small>Pago</small><b>${brl(pg)}</b></div>
                <div><small>Em aberto</small><b>${brl(tot - pg)}</b></div>
            </div>
        </div>
        <div class="drawer-b">${corpo}</div>
        <div class="drawer-f">
            <button class="btn btn-ghost" data-act="imp-abrir" data-id="${esc(f.id)}" title="Ler uma fatura em PDF, foto ou texto e distribuir entre as pessoas"><i class="bi bi-file-earmark-arrow-up"></i> Importar fatura</button>
            <button class="btn btn-gold magnet" data-act="item-novo" data-id="${esc(f.id)}"><i class="bi bi-plus-lg"></i> Novo lançamento</button>
        </div>`;
}

// ---------- Gaveta da pessoa ----------
function renderPessoa(anim = true) {
    const d = $('#dlgPessoa');
    const k = state.pessoaAberta;
    const a = anim && !reduzMovimento();
    const nome = nomeDe(k);
    const fs = faturasEscopo();
    const blocos = fs.map(f => ({ f, linhas: itens(f).map((p, i) => ({ p, i })).filter(l => norm(l.p.nome) === k && (state.escopo === 'mes' || !pago(l.p))) }))
        .filter(b => b.linhas.length)
        .sort((x, y) => infoMes(y.f.mes).ordem - infoMes(x.f.mes).ordem);
    const pend = blocos.flatMap(b => b.linhas).filter(l => !pago(l.p));
    const totPend = soma(pend.map(l => l.p));
    const tel = telDe(k);
    const cobs = cobrancasDe(k, fs);

    d.innerHTML = `
        <div class="drawer-h">
            <div class="row">
                ${avatar(nome, 'xl')}
                <div style="flex:1;min-width:0">
                    <div class="muted">${state.escopo === 'mes' ? esc(state.mes) : 'Todos os meses em aberto'}</div>
                    <h2>${esc(bonito(nome))}</h2>
                </div>
                <button class="icon-btn" data-act="fechar" title="Fechar"><i class="bi bi-x-lg"></i></button>
            </div>
            <div class="drawer-stats">
                <div><small>Em aberto</small><b>${brl(totPend)}</b></div>
                <div><small>Itens pendentes</small><b>${pend.length}</b></div>
                <div><small>Já cobrado</small><b>${cobs.length}x</b></div>
            </div>
        </div>
        <div class="drawer-b">
            <label class="field ${a ? 'rise' : ''}">
                <span>WhatsApp <em>número com DDI (55…) ou id de grupo</em></span>
                <input class="input mono" id="inTelPessoa" value="${esc(tel)}" placeholder="5511999999999" data-k="${esc(k)}" data-nome="${esc(nome)}">
            </label>
            ${cobs.length ? `<div class="hist-cob ${a ? 'rise' : ''}">
                <div class="grupo-sub" style="margin-top:0"><span><i class="bi bi-megaphone"></i> Cobranças destas pendências</span><span>${cobs.length}x</span></div>
                ${cobs.slice(0, 5).map(c => `<div class="hist-cob-i"><i class="bi ${c.canal === 'web' ? 'bi-box-arrow-up-right' : 'bi-whatsapp'}"></i><span>${esc(quando(c.criadoEm))}</span><span class="muted">${esc(c.meses.join(', '))}</span><b class="mono">${brl(c.total)}</b></div>`).join('')}
            </div>` : ''}
            ${blocos.map((b, bi) => `
                <div class="${a ? 'rise' : ''}" style="--i:${bi + 1}">
                    <div class="grupo-sub"><span>${esc(bonito(b.f.banco))}${state.escopo === 'tudo' ? ' · ' + esc(b.f.mes) : ''}</span><span class="mono">${brl(soma(b.linhas.map(l => l.p)))}</span></div>
                    <div class="grupo-pessoa" style="padding:6px">${b.linhas.map(l => linhaItem(b.f, l.p, l.i)).join('')}</div>
                </div>`).join('') || '<div class="tudo-em-dia"><i class="bi bi-emoji-smile"></i>Nada pendente.</div>'}
        </div>
        <div class="drawer-f">
            ${pend.length ? `<button class="btn btn-ok" data-act="pessoa-pago" data-k="${esc(k)}"><i class="bi bi-check2-all"></i> Tudo pago</button>
            <button class="btn btn-wa magnet" style="flex:1" data-act="whats-pessoa" data-k="${esc(k)}"><i class="bi bi-whatsapp"></i> Cobrar ${brl(totPend)}</button>` : '<button class="btn btn-ghost btn-block" data-act="fechar">Fechar</button>'}
        </div>`;
}

// =====================================================================
//  Diálogos
// =====================================================================
function abrir(d) { if (!d.open) d.showModal(); }
function fechar(d) {
    if (!d || !d.open || d.dataset.fechando) return;
    d.dataset.fechando = '1';
    d.classList.add('closing');
    let feito = false;
    const fim = () => {
        if (feito) return; feito = true;
        d.classList.remove('closing'); delete d.dataset.fechando;
        d.close();
    };
    if (reduzMovimento()) return fim();
    d.addEventListener('animationend', e => { if (e.target === d && !e.pseudoElement) fim(); });
    setTimeout(fim, 380);
}
function iniciarDialogos() {
    $$('dialog').forEach(d => {
        const fixo = d.id === 'dlgLogin'; // a tela de senha só fecha entrando
        d.addEventListener('cancel', e => { e.preventDefault(); if (!fixo) fechar(d); });
        d.addEventListener('mousedown', e => {
            if (e.target !== d || fixo) return;
            const r = d.getBoundingClientRect();
            const fora = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
            if (fora) fechar(d);
        });
    });
    $('#dlgConta').addEventListener('close', () => { state.contaAberta = null; });
    $('#dlgPessoa').addEventListener('close', () => { state.pessoaAberta = null; });
}

function confirmar({ titulo = 'Tem certeza?', texto = '', sim = 'Confirmar', perigo = false } = {}) {
    const d = $('#dlgConfirm');
    $('#cfTitulo').textContent = titulo;
    $('#cfTexto').textContent = texto;
    const bSim = $('#cfSim'), bNao = $('#cfNao');
    bSim.textContent = sim;
    bSim.className = perigo ? 'btn btn-danger' : 'btn btn-gold';
    abrir(d);
    return new Promise(res => {
        const fim = v => { bSim.onclick = bNao.onclick = null; d.removeEventListener('close', onClose); fechar(d); res(v); };
        const onClose = () => fim(false);
        bSim.onclick = () => fim(true);
        bNao.onclick = () => fim(false);
        d.addEventListener('close', onClose);
    });
}

// ---------- Lançamento ----------
const ctxItem = { faturaId: null, idx: null, pessoas: [] };

function abrirItem(faturaId, idx = null) {
    const f = acharFatura(faturaId);
    if (!f) return;
    ctxItem.faturaId = faturaId;
    ctxItem.idx = idx;
    const p = idx !== null ? itens(f)[idx] : null;
    ctxItem.pessoas = p ? [p.nome] : [];
    $('#itemTitulo').textContent = p ? 'Editar lançamento' : 'Novo lançamento';
    $('#itemSub').textContent = `${String(f.banco)} · ${f.mes}`;
    $('#inValor').value = p ? nf.format(p.valor) : '';
    $('#inDesc').value = p?.descricao || '';
    $('#inParc').value = p?.parcelaAtual || '';
    $('#inParcTot').value = p?.totalParcelas || '';
    $('#inPago').checked = p ? pago(p) : false;
    $('#inPessoa').value = '';
    renderChips();
    abrir($('#dlgItem'));
    setTimeout(() => (p ? $('#inValor') : $('#inPessoa')).focus(), 60);
}

function sugestoesPessoas() {
    const f = acharFatura(ctxItem.faturaId);
    const ja = new Set(ctxItem.pessoas.map(norm));
    const cand = new Map();
    const add = n => { const k = norm(n); if (k && !ja.has(k) && !cand.has(k)) cand.set(k, n); };
    if (f) {
        itens(f).forEach(p => add(p.nome));
        const ant = mesAnterior(f.mes);
        state.dados.filter(x => x.mes === ant && x.banco === f.banco).forEach(x => itens(x).forEach(p => add(p.nome)));
    }
    faturasDo(state.mes).forEach(x => itens(x).forEach(p => add(p.nome)));
    return [...cand.values()].slice(0, 8);
}

function renderChips() {
    const box = $('#chipsPessoas');
    $$('.chip', box).forEach(c => c.remove());
    const input = $('#inPessoa');
    ctxItem.pessoas.forEach((n, i) => {
        const c = document.createElement('span');
        c.className = 'chip';
        c.innerHTML = `${avatar(n)}${esc(bonito(n))}<button type="button" data-chip="${i}" aria-label="Remover ${esc(n)}"><i class="bi bi-x"></i></button>`;
        box.insertBefore(c, input);
    });
    input.placeholder = ctxItem.pessoas.length ? 'Dividir com…' : 'Nome da pessoa';
    $('#sugPessoas').innerHTML = sugestoesPessoas().map(n => `<button type="button" data-sug="${esc(n)}">+ ${esc(bonito(n))}</button>`).join('');
    atualizarDivisao();
}

function addChip(nome) {
    nome = String(nome || '').trim().replace(/,$/, '');
    if (!nome) return;
    if (!ctxItem.pessoas.some(n => norm(n) === norm(nome))) ctxItem.pessoas.push(nome);
    $('#inPessoa').value = '';
    renderChips();
}

function atualizarDivisao() {
    const n = ctxItem.pessoas.length;
    const v = parseValor($('#inValor').value);
    const h = $('#hintDivisao');
    $('#lblValor').textContent = n > 1 ? 'Valor total (será dividido)' : 'Valor';
    if (n > 1 && v > 0) {
        h.hidden = false;
        h.innerHTML = `Dividido entre ${n} pessoas: <b>${brl(Math.floor(v / n * 100) / 100)}</b> cada`;
    } else h.hidden = true;
}

function salvarItem(e) {
    e.preventDefault();
    if ($('#inPessoa').value.trim()) addChip($('#inPessoa').value);
    const f = acharFatura(ctxItem.faturaId);
    const nomes = ctxItem.pessoas.slice();
    const valor = parseValor($('#inValor').value);
    let pa = parseInt($('#inParc').value, 10) || null;
    let pt = parseInt($('#inParcTot').value, 10) || null;
    if (!f) return;
    if (!nomes.length) { sacudir($('#chipsPessoas')); return toast('Informe quem paga.', { tipo: 'bad' }); }
    if (!(valor > 0)) { sacudir($('#inValor')); return toast('Informe um valor maior que zero.', { tipo: 'bad' }); }
    if (pa && !pt) pt = null, pa = null;
    if (pt && !pa) pa = 1;
    if (pa && pt && pa > pt) { sacudir($('#inParc')); return toast('A parcela atual não pode ser maior que o total.', { tipo: 'bad' }); }

    // divide em centavos; a sobra vai para o primeiro
    const cents = Math.round(valor * 100);
    const base = Math.floor(cents / nomes.length);
    const valores = nomes.map((_, i) => (base + (i === 0 ? cents - base * nomes.length : 0)) / 100);
    const modelo = { parcelaAtual: pa, totalParcelas: pt, descricao: $('#inDesc').value.trim(), status: $('#inPago').checked ? 'ok' : 'pendente' };
    const editando = ctxItem.idx !== null;

    mutar(() => {
        const novos = nomes.map((nome, i) => ({ nome, valor: valores[i], ...modelo }));
        if (editando) itens(f).splice(ctxItem.idx, 1, ...novos);
        else itens(f).push(...novos);
    });
    fechar($('#dlgItem'));
    toast(editando ? 'Lançamento atualizado.' : nomes.length > 1 ? `Lançado e dividido entre ${nomes.length} pessoas.` : 'Lançamento adicionado.', { tipo: 'ok' });
}

// ---------- Novo mês ----------
const ctxMes = { alvo: null, origem: null, contas: new Set(), fixas: true };

function abrirNovoMes() {
    const ms = mesesOrdenados();
    const ultimo = ms.at(-1);
    const hoje = new Date();
    ctxMes.origem = ultimo || null;
    ctxMes.alvo = ultimo ? somarMeses(ultimo, 1) : rotuloDe(hoje.getMonth(), hoje.getFullYear());
    ctxMes.contas = new Set(ultimo ? faturasDo(ultimo).map(f => String(f.id)) : []);
    ctxMes.fixas = true;
    renderNovoMes();
    abrir($('#dlgNovoMes'));
}

function previaNovoMes() {
    const sel = faturasDo(ctxMes.origem).filter(f => ctxMes.contas.has(String(f.id)));
    let avancam = 0, fixos = 0, valor = 0;
    const quitadas = [];
    sel.forEach(f => itens(f).forEach(p => {
        if (continua(p)) { avancam++; valor += +p.valor || 0; }
        else if (temParcela(p)) quitadas.push({ p, f });
        else if (ctxMes.fixas) { fixos++; valor += +p.valor || 0; }
    }));
    return { sel, avancam, fixos, valor, quitadas };
}

function renderNovoMes() {
    const d = $('#dlgNovoMes');
    const ms = mesesOrdenados();
    const existe = ms.includes(ctxMes.alvo);
    const { nome, ano } = infoMes(ctxMes.alvo);
    const origem = ctxMes.origem;
    const pv = origem ? previaNovoMes() : null;
    const minAlvo = origem ? somarMeses(origem, 1) : null;

    d.innerHTML = `
        <div class="modal-h">
            <div><h2>Novo mês</h2><p>${origem ? `As contas de <b>${esc(origem)}</b> são levadas para o novo mês, com as parcelas avançadas.` : 'Comece um mês do zero, com as contas fixas da casa.'}</p></div>
            <button class="icon-btn" data-act="fechar" aria-label="Fechar"><i class="bi bi-x-lg"></i></button>
        </div>
        <div class="modal-b">
            <div class="mes-alvo">
                <button class="icon-btn" data-act="mes-alvo" data-d="-1" ${minAlvo && ctxMes.alvo === minAlvo ? 'disabled style="opacity:.3"' : ''} aria-label="Mês anterior"><i class="bi bi-chevron-left"></i></button>
                <div class="nome">${esc(nome)}<small>${ano}${existe ? ' · já existe' : ''}</small></div>
                <button class="icon-btn" data-act="mes-alvo" data-d="1" aria-label="Próximo mês"><i class="bi bi-chevron-right"></i></button>
            </div>
            ${pv ? `
            <div class="resumo-copia">
                <div><b>${pv.sel.length}</b><small>contas levadas</small></div>
                <div><b>${pv.avancam}</b><small>parcelas avançam</small></div>
                <div><b>${pv.fixos}</b><small>valores fixos repetidos</small></div>
            </div>
            <label class="switch">
                <input type="checkbox" data-act="mes-fixas" ${ctxMes.fixas ? 'checked' : ''}>
                <span><b>Repetir valores sem parcela</b><small>Aluguel, luz e afins entram com o valor de ${esc(origem)}, como pendentes, para você só ajustar</small></span>
            </label>
            <div class="field" style="margin-top:8px">
                <span>Contas a levar <em>${pv.sel.length}/${faturasDo(origem).length}</em></span>
                <div class="lista-check">${faturasDo(origem).map(f => `
                    <label><input type="checkbox" data-act="mes-conta" data-id="${esc(f.id)}" ${ctxMes.contas.has(String(f.id)) ? 'checked' : ''}>${logoConta(f.banco) ? `<img class="mini-logo" src="${logoConta(f.banco)}" alt="">` : ''}${esc(bonito(f.banco))}</label>`).join('')}
                </div>
            </div>
            ${pv.quitadas.length ? `<div class="quitadas-lista"><b><i class="bi bi-trophy"></i> ${plural(pv.quitadas.length, 'parcelamento termina', 'parcelamentos terminam')} em ${esc(origem)}</b> e não entra${pv.quitadas.length > 1 ? 'm' : ''} no novo mês: ${pv.quitadas.map(q => esc(q.p.descricao || q.f.banco)).join(', ')}.</div>` : ''}
            ` : ''}
        </div>
        <div class="modal-f">
            ${pv ? `<span class="grow muted" style="align-self:center;font-size:13px">Já lançado: <b class="mono" style="color:var(--text)">${brl(pv.valor)}</b></span>` : ''}
            <button class="btn btn-ghost" data-act="fechar">Cancelar</button>
            <button class="btn btn-gold" data-act="criar-mes" ${existe ? 'disabled' : ''}><i class="bi bi-calendar-plus"></i> Criar ${esc(nome)}</button>
        </div>`;
}

function criarMes() {
    const alvo = ctxMes.alvo;
    if (mesesOrdenados().includes(alvo)) return;
    const pv = ctxMes.origem ? previaNovoMes() : { sel: [] };
    const base = Date.now();
    mutar(() => {
        pv.sel.forEach((f, n) => {
            const novos = [];
            itens(f).forEach(p => {
                if (continua(p)) novos.push({ ...p, parcelaAtual: +p.parcelaAtual + 1, status: 'pendente' });
                else if (!temParcela(p) && ctxMes.fixas) novos.push({ ...p, status: 'pendente' });
            });
            state.dados.push({ id: base + n + Math.random(), banco: f.banco, mes: alvo, descricao: f.descricao || '', pessoas: novos });
        });
        garantirEspeciais(alvo);
        state.mes = alvo;
    }, { desfazer: `${alvo} criado com ${plural(faturasDo(alvo).length, 'conta')}.`, anim: true });
    fechar($('#dlgNovoMes'));
    const b = $('.btn-novo-mes').getBoundingClientRect();
    burst(b.left + b.width / 2, b.top + b.height / 2, 26);
}

// ---------- Nova conta ----------
function criarConta(e) {
    e.preventDefault();
    const banco = $('#inContaNome').value.trim();
    const descricao = $('#inContaDesc').value.trim();
    if (!banco) return sacudir($('#inContaNome'));
    if (faturasDo(state.mes).some(f => norm(f.banco) === norm(banco))) {
        sacudir($('#inContaNome'));
        return toast(`Já existe "${banco}" em ${state.mes}.`, { tipo: 'bad' });
    }
    const id = Date.now() + Math.random();
    mutar(() => state.dados.push({ id, banco, mes: state.mes, descricao, pessoas: [] }));
    fechar($('#dlgNovaConta'));
    $('#formConta').reset();
    setTimeout(() => abrirConta(id), 250);
}

// =====================================================================
//  Importar fatura: ler → distribuir entre pessoas → confirmar → lançar
// =====================================================================
const ctxImp = { faturaId: null, etapa: 'entrada', arquivo: null, texto: '', linhas: [], totalFatura: 0, bancoLido: '', viaIA: false };

// A leitura com IA é feita pelo bot; o servidor da página repassa pela rede interna.
async function urlExtrair() {
    return WHATSAPP ? { url: '/api/fatura/extrair' } : null;
}

/** Leitura simples, sem IA, de texto colado: uma linha com valor vira um item. */
function lerFaturaLocal(texto) {
    const itensLidos = [];
    for (let linha of String(texto || '').split(/\r?\n/)) {
        linha = linha.trim();
        if (!linha || /pagamento (efetuado|recebido)|saldo anterior|total da fatura|limite|vencimento|^total\b/i.test(linha)) continue;
        const valores = [...linha.matchAll(/-?\s?(?:R\$\s?)?\d{1,3}(?:\.\d{3})*,\d{2}\b|-?\s?(?:R\$\s?)?\d+[.,]\d{2}\b/g)];
        if (!valores.length) continue;
        const ult = valores[valores.length - 1];
        const valor = Math.abs(parseValor(ult[0].replace('-', '')));
        const credito = ult[0].includes('-') || /estorno|cr[eé]dito|devolu/i.test(linha);
        let resto = `${linha.slice(0, ult.index)} ${linha.slice(ult.index + ult[0].length)}`.trim();
        let data = '';
        const md = resto.match(/^(\d{2}\/\d{2})(?:\/\d{2,4})?\s+/);
        if (md) { data = md[1]; resto = resto.slice(md[0].length); }
        let parcelaAtual = null, totalParcelas = null;
        const mp = resto.match(/(?:parc(?:ela)?\.?\s*)?\b(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\b/i);
        if (mp && +mp[2] >= 2 && +mp[1] >= 1 && +mp[1] <= +mp[2]) {
            parcelaAtual = +mp[1]; totalParcelas = +mp[2];
            resto = resto.slice(0, mp.index) + resto.slice(mp.index + mp[0].length);
        }
        const descricao = resto.replace(/R\$/g, '').replace(/^[\s\-–:•*]+|[\s\-–:•*]+$/g, '').replace(/\s{2,}/g, ' ').trim();
        if (valor > 0) itensLidos.push({ data, descricao, valor, parcelaAtual, totalParcelas, credito });
    }
    return { banco: '', totalFatura: 0, itens: itensLidos };
}

function nomeEuPadrao() {
    for (const f of state.dados.slice().sort((a, b) => infoMes(b.mes).ordem - infoMes(a.mes).ordem)) {
        const p = itens(f).find(x => ehEu(x.nome));
        if (p) return p.nome;
    }
    return NOME_EU;
}

/** Quem costuma pagar algo parecido? Procura a descrição nos lançamentos, do mês mais recente para trás. */
function sugerirPessoa(descricao) {
    const toks = norm(descricao).split(/[^a-z0-9]+/).filter(t => t.length >= 4 && !/^(parc|parcela|compra|loja|pagamento|brasil|ltda)$/.test(t));
    if (toks.length) {
        for (const f of state.dados.slice().sort((a, b) => infoMes(b.mes).ordem - infoMes(a.mes).ordem)) {
            const p = itens(f).find(x => x.descricao && toks.some(t => norm(x.descricao).includes(t)));
            if (p) return p.nome;
        }
    }
    return nomeEuPadrao();
}

function prepararLinhas(fatura, f) {
    const usados = new Set();
    return fatura.itens.map((it, i) => {
        // "Já lançado": mesmo valor (e mesma parcela, se houver) de um item que já está na conta
        const idx = itens(f).findIndex((p, j) => !usados.has(j) && Math.abs((+p.valor || 0) - it.valor) < .005 &&
            (!it.totalParcelas || (+p.parcelaAtual === it.parcelaAtual && +p.totalParcelas === it.totalParcelas)));
        if (idx >= 0) usados.add(idx);
        return {
            id: i,
            data: it.data || '',
            descricao: it.descricao || '',
            valor: it.valor,
            parcelaAtual: it.parcelaAtual || null,
            totalParcelas: it.totalParcelas || null,
            credito: !!it.credito,
            pessoas: [sugerirPessoa(it.descricao)],
            sel: false,
            dup: idx >= 0,
            incluir: idx < 0 && !it.credito,
        };
    });
}

function abrirImport(faturaId) {
    Object.assign(ctxImp, { faturaId, etapa: 'entrada', arquivo: null, texto: '', linhas: [], totalFatura: 0, bancoLido: '', viaIA: false });
    renderImport();
    abrir($('#dlgImport'));
}

async function renderImport() {
    const d = $('#dlgImport');
    const f = acharFatura(ctxImp.faturaId);
    if (!f) return fechar(d);
    const cab = (titulo, sub) => `
        <div class="modal-h">
            <div><h2>${titulo}</h2><p>${sub}</p></div>
            <button class="icon-btn" data-act="fechar" aria-label="Fechar"><i class="bi bi-x-lg"></i></button>
        </div>`;
    const onde = `${icoConta(f.banco)}<b>${esc(bonito(f.banco))}</b> · ${esc(f.mes)}`;

    if (ctxImp.etapa === 'entrada') {
        const temIA = !!(await urlExtrair());
        d.innerHTML = `${cab('Importar fatura', `<span class="imp-onde">${onde}</span>`)}
        <div class="modal-b">
            <label class="drop ${ctxImp.arquivo ? 'com-arquivo' : ''}" id="impDrop">
                <input type="file" id="impArquivo" accept="application/pdf,image/jpeg,image/png,image/webp" hidden>
                ${ctxImp.arquivo
                    ? `<i class="bi ${ctxImp.arquivo.mimeType === 'application/pdf' ? 'bi-file-earmark-pdf' : 'bi-file-earmark-image'}"></i><b>${esc(ctxImp.arquivo.nome)}</b><small>${(ctxImp.arquivo.tamanho / 1024).toFixed(0)} KB · clique para trocar</small>
                       <button type="button" class="icon-btn sm bad drop-x" data-act="imp-sem-arquivo" title="Remover arquivo"><i class="bi bi-x-lg"></i></button>`
                    : `<i class="bi bi-cloud-arrow-up"></i><b>Arraste o PDF ou a foto da fatura</b><small>ou clique para escolher · PDF, JPG, PNG ou WEBP até 12 MB</small>`}
            </label>
            <div class="ou"><span>ou cole o texto da fatura / das cobranças</span></div>
            <textarea class="input" id="impTexto" rows="6" placeholder="02/09 UBER TRIP 23,50&#10;05/09 MERCADO LIVRE 02/05 75,20&#10;mercado 120,00">${esc(ctxImp.texto)}</textarea>
            ${temIA ? '<div class="hint" style="margin:10px 0 0"><i class="bi bi-stars"></i> Leitura com IA pelo bot. Você revisa e distribui antes de lançar.</div>'
                : '<div class="hint" style="margin:10px 0 0;color:var(--pend)"><i class="bi bi-info-circle"></i> Esta instalação está sem o bot (e a IA), então só o texto colado é lido, numa leitura simples. Para ler PDF e fotos, ative o bot (veja o README).</div>'}
        </div>
        <div class="modal-f">
            <button class="btn btn-ghost" data-act="fechar">Cancelar</button>
            <button class="btn btn-gold" data-act="imp-ler"><i class="bi bi-stars"></i> Ler fatura</button>
        </div>`;
        return;
    }

    if (ctxImp.etapa === 'lendo') {
        d.innerHTML = `${cab('Lendo a fatura…', `<span class="imp-onde">${onde}</span>`)}
        <div class="modal-b"><div class="imp-lendo">${Array.from({ length: 6 }, (_, i) => `<div class="skel" style="--i:${i}"></div>`).join('')}</div>
        <p class="muted" style="text-align:center;margin:14px 0 0;font-size:13px">${ctxImp.arquivo ? 'A IA está lendo o documento. Faturas grandes levam alguns segundos.' : 'Separando as linhas…'}</p></div>`;
        return;
    }

    // revisão
    d.innerHTML = `${cab('Distribuir e confirmar', `<span class="imp-onde">${onde}</span> · ${plural(ctxImp.linhas.length, 'linha lida', 'linhas lidas')}${ctxImp.viaIA ? ' com IA' : ''}${ctxImp.bancoLido ? ` · fatura ${esc(ctxImp.bancoLido)}` : ''}`)}
        <div class="imp-bar" id="impBar"></div>
        <div class="modal-b imp-lista" id="impLista"></div>
        <div class="imp-resumo" id="impResumo"></div>
        <div class="modal-f">
            <button class="btn btn-ghost" data-act="imp-voltar"><i class="bi bi-arrow-left"></i> Voltar</button>
            <span class="grow"></span>
            <button class="btn btn-gold" data-act="imp-lancar" id="btnImpLancar"></button>
        </div>`;
    renderImpBar(); renderImpLista(true); renderImpResumo();
}

function pessoasSugeridasImp() {
    const f = acharFatura(ctxImp.faturaId);
    const m = new Map();
    const add = n => { const k = norm(n); if (k && !m.has(k)) m.set(k, n); };
    ctxImp.linhas.forEach(l => l.pessoas.forEach(add));
    if (f) itens(f).forEach(p => add(p.nome));
    faturasDo(f ? f.mes : state.mes).forEach(x => itens(x).forEach(p => add(p.nome)));
    return [...m.values()].slice(0, 10);
}

function renderImpBar() {
    const sel = ctxImp.linhas.filter(l => l.sel);
    const todas = ctxImp.linhas.length && sel.length === ctxImp.linhas.length;
    $('#impBar').innerHTML = `
        <label class="imp-all"><input type="checkbox" data-act="imp-sel-todos" ${todas ? 'checked' : ''}> ${sel.length ? `${sel.length} selecionada${sel.length > 1 ? 's' : ''}` : 'Selecionar'}</label>
        <span class="imp-dica">${sel.length ? 'Toque numa pessoa para pôr ou tirar das selecionadas. Várias pessoas dividem o valor.' : 'Selecione linhas para atribuir em lote.'}</span>
        <div class="imp-pessoas">
            ${pessoasSugeridasImp().map(n => {
                const k = norm(n);
                const em = sel.length && sel.every(l => l.pessoas.some(p => norm(p) === k));
                return `<button class="imp-chip ${em ? 'on' : ''}" data-act="imp-pessoa" data-nome="${esc(n)}" ${sel.length ? '' : 'disabled'}>${avatar(n)}${esc(bonito(n))}</button>`;
            }).join('')}
            <input class="imp-nova" id="impNovaPessoa" placeholder="+ pessoa" list="dlPessoas" ${sel.length ? '' : 'disabled'}>
        </div>`;
}

function linhaImp(l) {
    const n = l.pessoas.length;
    const cada = n > 1 ? (Math.floor(Math.round(l.valor * 100) / n) / 100) : null;
    return `
    <div class="imp-row ${l.sel ? 'sel' : ''} ${l.incluir ? '' : 'off'}" data-li="${l.id}">
        <input type="checkbox" data-act="imp-sel" data-li="${l.id}" ${l.sel ? 'checked' : ''} aria-label="Selecionar linha">
        <div class="imp-desc">
            <input class="imp-in" data-campo="descricao" data-li="${l.id}" value="${esc(l.descricao)}" placeholder="Descrição">
            <small>${esc(l.data)}${l.totalParcelas ? ` <span class="parc">${l.parcelaAtual}/${l.totalParcelas}</span>` : ''}${l.dup ? ' <span class="tag mute" title="Já existe um lançamento igual nesta conta">já lançado</span>' : ''}${l.credito ? ' <span class="tag ok">estorno</span>' : ''}</small>
        </div>
        <div class="imp-pes">
            ${l.pessoas.map(p => `<span class="chip">${avatar(p)}${esc(bonito(p))}<button type="button" data-act="imp-tirar" data-li="${l.id}" data-nome="${esc(p)}" aria-label="Tirar ${esc(p)}"><i class="bi bi-x"></i></button></span>`).join('')}
            ${n ? '' : '<span class="tag pend">sem pessoa</span>'}
            ${cada ? `<small class="muted">${brl(cada)} cada</small>` : ''}
        </div>
        <input class="imp-in mono imp-val" data-campo="valor" data-li="${l.id}" value="${nf.format(l.valor)}" inputmode="decimal" aria-label="Valor">
        <button class="icon-btn sm ${l.incluir ? 'bad' : 'ok'}" data-act="imp-incluir" data-li="${l.id}" title="${l.incluir ? 'Não lançar esta linha' : 'Lançar esta linha'}"><i class="bi ${l.incluir ? 'bi-dash-circle' : 'bi-plus-circle'}"></i></button>
    </div>`;
}

function renderImpLista(anim = false) {
    const box = $('#impLista');
    const topo = box.scrollTop;
    box.innerHTML = ctxImp.linhas.length
        ? ctxImp.linhas.map(linhaImp).join('')
        : '<div class="vazio-estado"><i class="bi bi-search"></i><h3>Nenhuma linha com valor</h3><p>Volte e confira o texto ou o arquivo.</p></div>';
    box.scrollTop = topo;
    if (anim && !reduzMovimento()) $$('.imp-row', box).forEach((r, i) => { r.classList.add('rise'); r.style.setProperty('--i', Math.min(i, 14)); });
}

function totaisImp() {
    const porPessoa = new Map();
    let atribuido = 0, incluidas = 0, semPessoa = 0;
    for (const l of ctxImp.linhas) {
        if (!l.incluir) continue;
        incluidas++;
        const sinal = l.credito ? -1 : 1;
        if (!l.pessoas.length) { semPessoa++; continue; }
        const cents = Math.round(l.valor * 100);
        const base = Math.floor(cents / l.pessoas.length);
        l.pessoas.forEach((p, i) => {
            const v = sinal * (base + (i === 0 ? cents - base * l.pessoas.length : 0)) / 100;
            const k = norm(p);
            const o = porPessoa.get(k) || { nome: p, total: 0 };
            o.total += v;
            porPessoa.set(k, o);
        });
        atribuido += sinal * l.valor;
    }
    return { porPessoa: [...porPessoa.values()].sort((a, b) => b.total - a.total), atribuido, incluidas, semPessoa };
}

function renderImpResumo() {
    const t = totaisImp();
    const total = ctxImp.totalFatura || ctxImp.linhas.filter(l => !l.dup).reduce((s, l) => s + (l.credito ? -l.valor : l.valor), 0);
    const pct = total > 0 ? Math.max(0, Math.min(1, t.atribuido / total)) : 0;
    $('#impResumo').innerHTML = `
        <div class="imp-pp">${t.porPessoa.map(p => `<span class="imp-pp-i">${avatar(p.nome)}<span><b>${esc(bonito(p.nome))}</b><small class="mono">${brl(p.total)}</small></span></span>`).join('') || '<span class="muted">Ninguém atribuído ainda.</span>'}</div>
        <div class="imp-total">
            <div class="imp-total-l"><span>Distribuído <b class="mono">${brl(t.atribuido)}</b> de</span>
                <input class="imp-in mono" id="impTotalFatura" value="${nf.format(total)}" inputmode="decimal" title="Total da fatura (editável)"></div>
            <div class="conta-bar" style="--p:${pct.toFixed(3)}"><i></i></div>
            <small class="${Math.abs(total - t.atribuido) < .01 ? 'ok-txt' : 'muted'}">${Math.abs(total - t.atribuido) < .01 ? '✓ bate com o total' : `${t.atribuido < total ? 'faltam' : 'passou'} ${brl(Math.abs(total - t.atribuido))}${ctxImp.linhas.some(l => l.dup && !l.incluir) ? ' (linhas já lançadas ficam de fora)' : ''}`}</small>
        </div>`;
    const b = $('#btnImpLancar');
    b.disabled = !t.incluidas || t.semPessoa > 0;
    b.innerHTML = t.semPessoa
        ? `<i class="bi bi-person-exclamation"></i> ${plural(t.semPessoa, 'linha', 'linhas')} sem pessoa`
        : `<i class="bi bi-check2-all"></i> Lançar ${plural(ctxImp.linhas.filter(l => l.incluir).reduce((s, l) => s + l.pessoas.length, 0), 'lançamento')}`;
}

async function lerImport() {
    ctxImp.texto = ($('#impTexto') || {}).value || ctxImp.texto;
    if (!ctxImp.arquivo && !ctxImp.texto.trim()) { sacudir($('#impDrop')); return toast('Envie um arquivo ou cole o texto da fatura.', { tipo: 'bad' }); }
    const f = acharFatura(ctxImp.faturaId);
    const ia = await urlExtrair();
    if (ctxImp.arquivo && !ia) return toast('Para ler PDF ou foto, esta instalação precisa do bot com IA (veja o README).', { tipo: 'bad' });
    ctxImp.etapa = 'lendo';
    renderImport();
    let fatura = null;
    ctxImp.viaIA = false;
    if (ia) {
        try {
            const r = await fetch(ia.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ texto: ctxImp.texto, arquivo: ctxImp.arquivo ? { base64: ctxImp.arquivo.base64, mimeType: ctxImp.arquivo.mimeType } : undefined }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.sucesso) throw new Error(j.erro || `bot respondeu ${r.status}`);
            fatura = j.fatura;
            ctxImp.viaIA = true;
        } catch (e) {
            if (ctxImp.arquivo) {
                ctxImp.etapa = 'entrada';
                renderImport();
                return toast(`Não consegui ler o arquivo: ${e.message}`, { tipo: 'bad', duracao: 8000 });
            }
            toast(`A leitura com IA falhou (${e.message}). Usei a leitura simples do texto.`, { tipo: 'bad' });
        }
    }
    if (!fatura) fatura = lerFaturaLocal(ctxImp.texto);
    ctxImp.linhas = prepararLinhas(fatura, f);
    ctxImp.totalFatura = fatura.totalFatura || 0;
    ctxImp.bancoLido = fatura.banco || '';
    ctxImp.etapa = 'revisao';
    renderImport();
}

function lancarImport(btn) {
    const f = acharFatura(ctxImp.faturaId);
    const t = totaisImp();
    if (!f || !t.incluidas || t.semPessoa) return;
    const novos = [];
    for (const l of ctxImp.linhas) {
        if (!l.incluir || !l.pessoas.length) continue;
        const cents = Math.round(l.valor * 100);
        const base = Math.floor(cents / l.pessoas.length);
        l.pessoas.forEach((nome, i) => novos.push({
            nome,
            valor: (l.credito ? -1 : 1) * (base + (i === 0 ? cents - base * l.pessoas.length : 0)) / 100,
            parcelaAtual: l.totalParcelas ? l.parcelaAtual || 1 : null,
            totalParcelas: l.totalParcelas || null,
            descricao: l.descricao.trim() + (l.credito ? ' (estorno)' : ''),
            status: 'pendente',
            origem: 'fatura',
        }));
    }
    const r = btn.getBoundingClientRect();
    mutar(() => itens(f).push(...novos), { desfazer: `${plural(novos.length, 'lançamento importado', 'lançamentos importados')} em ${bonito(f.banco)}.` });
    burst(r.left + r.width / 2, r.top + r.height / 2, 28);
    fechar($('#dlgImport'));
}

function lerArquivoImp(file) {
    if (!file) return;
    const tipos = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!tipos.includes(file.type)) return toast('Use PDF, JPG, PNG ou WEBP.', { tipo: 'bad' });
    if (file.size > 12 * 1024 * 1024) return toast('Arquivo grande demais (máx. 12 MB).', { tipo: 'bad' });
    const fr = new FileReader();
    fr.onload = () => {
        ctxImp.texto = ($('#impTexto') || {}).value || ctxImp.texto;
        ctxImp.arquivo = { nome: file.name, mimeType: file.type, tamanho: file.size, base64: String(fr.result).split(',')[1] };
        renderImport();
    };
    fr.readAsDataURL(file);
}

function abrirConta(id) {
    state.contaAberta = String(id);
    renderConta(true);
    abrir($('#dlgConta'));
}
function abrirPessoa(k) {
    state.pessoaAberta = k;
    renderPessoa(true);
    abrir($('#dlgPessoa'));
}

// =====================================================================
//  WhatsApp
// =====================================================================
function descreverItem(item) {
    const parcela = item.parcelaAtual ? `(parcela ${item.parcelaAtual}/${item.totalParcelas})` : '';
    return [item.descricao, parcela].filter(Boolean).join(' ');
}

/** Mensagem de cobrança de uma pessoa (por chave normalizada). null se nada pendente. */
function montarMensagemCobranca(k, faturas) {
    const nome = nomeDe(k);
    const grupos = [];
    let total = 0, qtd = 0;
    faturas.forEach(f => {
        const pend = itens(f).filter(p => norm(p.nome) === k && !pago(p));
        if (!pend.length) return;
        const sub = soma(pend);
        total += sub; qtd += pend.length;
        grupos.push({ banco: f.banco, mes: f.mes, itens: pend, sub });
    });
    if (!grupos.length) return null;

    let texto = `Olá ${nome}! 👋\n\nSegue o resumo das suas pendências:\n\n`;
    grupos.forEach(g => {
        if (g.itens.length === 1) {
            const det = descreverItem(g.itens[0]);
            texto += `• *${g.banco}* (${g.mes})${det ? ` — ${det}` : ''}: ${brl(g.itens[0].valor)}\n`;
        } else {
            texto += `• *${g.banco}* (${g.mes})\n`;
            g.itens.forEach(i => { const det = descreverItem(i); texto += `    ◦ ${det ? `${det}: ` : ''}${brl(i.valor)}\n`; });
            texto += `    _subtotal ${brl(g.sub)}_\n`;
        }
    });
    texto += `\n━━━━━━━━━━━━━━━\n💵 *TOTAL: ${brl(total)}*\n`;
    texto += `_${qtd} ${qtd === 1 ? 'pendência' : 'pendências'}_\n\n`;
    texto += `Qualquer dúvida é só me chamar. Obrigado! 🙏`;
    return { texto, total, qtd, nome };
}

async function enviarPelaApi(numero, texto) {
    if (!WHATSAPP) return { ok: false, erro: 'Esta instalação está sem o bot do WhatsApp.' };
    try {
        const corpo = { numero: String(numero), texto };
        if (lsGet('aurea.audio') === '1') corpo.audio = 'cobranca';
        const r = await fetch('/api/whatsapp/enviar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(corpo)
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.sucesso) return { ok: true };
        return { ok: false, erro: j.erro || j.error || `Código ${r.status}` };
    } catch (err) {
        return { ok: false, erro: `Falha de conexão: ${err.message}` };
    }
}

function abrirWhatsAppWeb(numero, texto) {
    const alvo = numero && !String(numero).includes('@') ? `phone=${String(numero).replace(/\D/g, '')}&` : '';
    window.open(`https://api.whatsapp.com/send?${alvo}text=${encodeURIComponent(texto)}`, '_blank');
}

function copiar(texto) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(texto).then(() => true, () => false);
    try {
        const ta = document.createElement('textarea');
        ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        return Promise.resolve(true);
    } catch (e) { return Promise.resolve(false); }
}

const ctxEnvio = { k: null, cobranca: null };
function abrirEnvio(k, faturas) {
    const c = montarMensagemCobranca(k, faturas);
    if (!c) return toast(`${nomeDe(k)} não tem pendências aqui. 🎉`, { tipo: 'ok' });
    ctxEnvio.k = k; ctxEnvio.cobranca = c; ctxEnvio.faturas = faturas;
    const d = $('#dlgEnvio');
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    d.innerHTML = `
        <div class="modal-h">
            <div><h2>Cobrar <span style="text-transform:capitalize">${esc(bonito(c.nome))}</span></h2><p>${plural(c.qtd, 'pendência')} · <b class="mono" style="color:var(--text)">${brl(c.total)}</b></p></div>
            <button class="icon-btn" data-act="fechar" aria-label="Fechar"><i class="bi bi-x-lg"></i></button>
        </div>
        <div class="modal-b">
            <div class="wa-to">${avatar(c.nome, 'lg')}<input class="input" id="inTelEnvio" value="${esc(telDe(k))}" placeholder="WhatsApp: 5511999999999"></div>
            <div class="wa-preview"><div class="wa-bubble">${esc(c.texto).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/_([^_\n]+)_/g, '<i>$1</i>')}<time>${hora} ✓✓</time></div></div>
            <div class="hint" id="envioErro" style="margin:12px 0 0;color:var(--bad)" hidden></div>
        </div>
        <div class="modal-f">
            <button class="btn btn-ghost btn-sm" data-act="envio-copiar"><i class="bi bi-clipboard"></i> Copiar</button>
            <button class="btn btn-ghost btn-sm" data-act="envio-web"><i class="bi bi-box-arrow-up-right"></i> WhatsApp Web</button>
            <span class="grow"></span>
            <button class="btn btn-wa" data-act="envio-bot" id="btnEnviarBot"><i class="bi bi-send"></i> Enviar pelo bot</button>
        </div>`;
    abrir(d);
}

async function enviarBot(btn) {
    const tel = $('#inTelEnvio').value.trim();
    const { k, cobranca } = ctxEnvio;
    if (!tel) { sacudir($('#inTelEnvio')); return toast('Informe o número de WhatsApp.', { tipo: 'bad' }); }
    if (tel !== telDe(k)) await salvarTel(k, cobranca.nome, tel);
    btn.disabled = true;
    btn.innerHTML = '<span class="spin" style="width:16px;height:16px;border:2px solid #052e15;border-top-color:transparent;border-radius:50%;display:inline-block;animation:spin .8s linear infinite"></span> Enviando…';
    const r = await enviarPelaApi(telDe(k), cobranca.texto);
    if (r.ok) {
        const b = btn.getBoundingClientRect();
        burst(b.left + b.width / 2, b.top + b.height / 2, 18, ['#25D366', '#f8dc92', '#e8b94a']);
        registrarCobranca(k, ctxEnvio.faturas, cobranca.total, 'bot');
        fechar($('#dlgEnvio'));
        return toast(`Cobrança enviada para ${cobranca.nome}.`, { tipo: 'ok' });
    }
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Tentar de novo';
    const e = $('#envioErro');
    e.hidden = false;
    e.textContent = `Não consegui enviar: ${r.erro}. Você pode copiar a mensagem ou abrir o WhatsApp Web.`;
}

function abrirLote() {
    const lista = pendentesPorPessoa(faturasEscopo()).map(p => ({ ...p, tel: telDe(p.k) }));
    if (!lista.length) return toast('Ninguém com pendência neste período. 🎉', { tipo: 'ok' });
    const d = $('#dlgLote');
    d.innerHTML = `
        <div class="modal-h">
            <div><h2>Cobrar todos</h2><p>Uma mensagem por pessoa, com tudo que está em aberto ${state.escopo === 'mes' ? `em ${esc(state.mes)}` : 'em todos os meses'}. Enviadas uma a uma.</p></div>
            <button class="icon-btn" data-act="fechar" aria-label="Fechar"><i class="bi bi-x-lg"></i></button>
        </div>
        <div class="modal-b">
            ${lista.map(p => `
            <div class="lote-row ${p.tel ? '' : 'sem-tel'}" data-k="${esc(p.k)}">
                <input type="checkbox" ${p.tel ? 'checked' : 'disabled'} aria-label="Incluir ${esc(p.nome)}">
                ${avatar(p.nome)}
                <div class="nm"><b>${esc(bonito(p.nome))}</b><small>${p.tel ? esc(p.tel) : 'sem telefone · abra a pessoa para cadastrar'}</small>${seloCobrado(p.k)}</div>
                <b class="mono">${brl(p.total)}</b>
                <span class="st"></span>
            </div>`).join('')}
        </div>
        <div class="modal-f">
            <button class="btn btn-ghost" data-act="fechar">Cancelar</button>
            <button class="btn btn-wa" data-act="lote-enviar"><i class="bi bi-send"></i> Enviar cobranças</button>
        </div>`;
    abrir(d);
}

async function enviarLote(btn) {
    const d = $('#dlgLote');
    const rows = $$('.lote-row', d).filter(r => $('input', r).checked);
    if (!rows.length) return toast('Selecione ao menos uma pessoa.', { tipo: 'bad' });
    btn.disabled = true;
    $$('input', d).forEach(i => { i.disabled = true; });
    const fs = faturasEscopo();
    let ok = 0, falhas = 0;
    for (const [n, row] of rows.entries()) {
        const k = row.dataset.k;
        const st = $('.st', row);
        btn.innerHTML = `<i class="bi bi-hourglass-split"></i> Enviando ${n + 1}/${rows.length}…`;
        st.innerHTML = '<span class="spin"></span>';
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        const c = montarMensagemCobranca(k, fs);
        const r = c ? await enviarPelaApi(telDe(k), c.texto) : { ok: false, erro: 'nada pendente' };
        if (r.ok) { ok++; st.innerHTML = '<i class="bi bi-check-circle-fill" style="color:var(--ok)"></i>'; registrarCobranca(k, fs, c.total, 'bot'); }
        else { falhas++; st.innerHTML = `<i class="bi bi-x-circle-fill" style="color:var(--bad)" title="${esc(r.erro)}"></i>`; $('.nm small', row).textContent = r.erro; }
    }
    btn.disabled = false;
    btn.dataset.act = 'fechar';
    btn.className = 'btn btn-gold';
    btn.innerHTML = '<i class="bi bi-check2"></i> Concluir';
    toast(`${plural(ok, 'cobrança enviada', 'cobranças enviadas')}${falhas ? ` · ${falhas} com falha` : ''}.`, { tipo: falhas ? 'bad' : 'ok', duracao: 7000 });
}

// ---------- Configurações ----------
// Estado do bot (conexão e QR para parear o número). Atualiza enquanto a tela estiver aberta.
let timerStatusBot = null;
async function atualizarStatusBot() {
    const box = $('#cfgBot');
    if (!WHATSAPP) {
        box.innerHTML = '<i class="bi bi-whatsapp"></i><div><b>WhatsApp desligado</b><small>Esta instalação está sem o bot. Para cobrar e lançar pelo WhatsApp, ative o bot (veja o README).</small></div>';
        return;
    }
    let s = null;
    try { const r = await fetch('/api/whatsapp/status', { cache: 'no-store' }); s = await r.json(); } catch (e) { s = null; }
    if (!$('#dlgConfig').open) return;
    if (!s || !s.whatsapp) {
        box.innerHTML = '<i class="bi bi-exclamation-triangle" style="color:var(--bad)"></i><div><b>Bot fora do ar</b><small>O servidor não conseguiu falar com o bot. Confira se o serviço "bot" está rodando (docker compose ps).</small></div>';
    } else if (s.whatsapp === 'connected') {
        box.innerHTML = `<i class="bi bi-whatsapp"></i><div><b>WhatsApp conectado</b><small>Cobranças saem por este número. Para lançar pelo WhatsApp: crie um grupo com este número e mande <code>!financas</code> nele. O agente confirma mês, conta, quem paga e parcelas, e só lança depois do seu <b>OK</b>.</small></div>`;
    } else if (s.qr) {
        box.innerHTML = `<i class="bi bi-qr-code-scan"></i><div><b>Conecte o número do bot</b><small>No celular que será o bot: WhatsApp › Aparelhos conectados › Conectar um aparelho, e aponte para o código.</small><img class="cfg-qr" src="${esc(s.qr)}" alt="QR Code do WhatsApp"></div>`;
    } else {
        box.innerHTML = '<i class="bi bi-hourglass-split"></i><div><b>Conectando ao WhatsApp…</b><small>Aguarde alguns segundos.</small></div>';
    }
}
function abrirConfig() {
    $('#cfgAudio').checked = lsGet('aurea.audio') === '1';
    $('#cfgMotion').checked = document.documentElement.dataset.motion === 'reduced';
    abrir($('#dlgConfig'));
    atualizarStatusBot();
    clearInterval(timerStatusBot);
    timerStatusBot = setInterval(() => { if ($('#dlgConfig').open) atualizarStatusBot(); else clearInterval(timerStatusBot); }, 4000);
}
function salvarConfig(e) {
    e.preventDefault();
    lsSet('aurea.audio', $('#cfgAudio').checked ? '1' : '');
    const red = $('#cfgMotion').checked;
    if (red) document.documentElement.dataset.motion = 'reduced'; else delete document.documentElement.dataset.motion;
    lsSet('aurea.motion', red ? 'reduced' : '');
    fechar($('#dlgConfig'));
    toast('Preferências salvas.', { tipo: 'ok' });
}
async function sair() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (e) { /* ignora */ }
    try { await localforage.removeItem('dadosFinanceiros'); } catch (e) { /* ignora */ }
    location.reload();
}

// =====================================================================
//  Efeitos
// =====================================================================
function toast(msg, { tipo = 'info', acao, onAcao, duracao = 5200 } = {}) {
    const t = document.createElement('div');
    t.className = `toast ${tipo}`;
    const ic = { ok: 'bi-check-circle-fill', bad: 'bi-exclamation-triangle-fill', info: 'bi-stars' }[tipo] || 'bi-stars';
    t.innerHTML = `<i class="bi ${ic}"></i><p>${esc(msg)}</p>${acao ? `<button>${esc(acao)}</button>` : ''}`;
    const sair = () => { if (t.classList.contains('out')) return; t.classList.add('out'); setTimeout(() => t.remove(), 320); };
    if (acao) t.querySelector('button').onclick = () => { onAcao?.(); sair(); };
    $('#toasts').appendChild(t);
    setTimeout(sair, acao ? Math.max(duracao, 7000) : duracao);
}

function burst(x, y, n = 14, cores = ['#f8dc92', '#e8b94a', '#a8781f', '#4fcf8b']) {
    if (reduzMovimento()) return;
    for (let i = 0; i < n; i++) {
        const s = document.createElement('i');
        s.className = 'spark';
        const ang = Math.random() * Math.PI * 2;
        const dist = 40 + Math.random() * 70;
        s.style.left = x + 'px'; s.style.top = y + 'px';
        s.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
        s.style.setProperty('--dy', Math.sin(ang) * dist + 30 + 'px');
        s.style.setProperty('--r', (Math.random() * 540 - 270) + 'deg');
        s.style.setProperty('--c', cores[i % cores.length]);
        if (Math.random() > .5) s.style.borderRadius = '50%';
        document.body.appendChild(s);
        setTimeout(() => s.remove(), 950);
    }
}

function sacudir(el) {
    if (!el || reduzMovimento()) return;
    el.animate([{ translate: '0' }, { translate: '-6px' }, { translate: '6px' }, { translate: '-3px' }, { translate: '0' }], { duration: 360, easing: 'ease-out' });
    el.focus?.();
}

const memoContagem = new Map();
function contar(el) {
    const key = el.dataset.key;
    const to = +el.dataset.count;
    const inteiro = !!el.dataset.int;
    const from = memoContagem.has(key) ? memoContagem.get(key) : 0;
    memoContagem.set(key, to);
    const fmt = v => inteiro ? String(Math.round(v)) : nf.format(v);
    if (reduzMovimento() || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 1000;
    const passo = t => {
        const k = Math.min(1, (t - t0) / dur);
        const e = k === 1 ? 1 : 1 - Math.pow(2, -10 * k);
        el.textContent = fmt(from + (to - from) * e);
        if (k < 1) requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
}

function flashItem(id, i) {
    $$(`.item[data-id="${CSS.escape(String(id))}"][data-i="${i}"]`).forEach(el => el.classList.add('flash'));
}

function iniciarCursor() {
    if (matchMedia('(pointer: coarse)').matches) return;
    let atual = null, mag = null;
    const soltar = el => { if (el) el.style.transform = ''; };
    document.addEventListener('pointermove', e => {
        if (reduzMovimento()) return;
        const fx = e.target.closest?.('.fx');
        if (atual !== fx) { soltar(atual); atual = fx; }
        if (fx) {
            const r = fx.getBoundingClientRect();
            const x = e.clientX - r.left, y = e.clientY - r.top;
            fx.style.setProperty('--mx', x + 'px');
            fx.style.setProperty('--my', y + 'px');
            if (fx.classList.contains('tilt')) {
                const px = x / r.width - .5, py = y / r.height - .5;
                fx.style.transform = `perspective(900px) rotateX(${(-py * 7).toFixed(2)}deg) rotateY(${(px * 7).toFixed(2)}deg)`;
            }
        }
        const m = e.target.closest?.('.magnet');
        if (mag !== m) { if (mag) mag.style.translate = ''; mag = m; }
        if (m && !m.disabled) {
            const r = m.getBoundingClientRect();
            m.style.translate = `${((e.clientX - r.left - r.width / 2) * .16).toFixed(1)}px ${((e.clientY - r.top - r.height / 2) * .28).toFixed(1)}px`;
        }
    }, { passive: true });
    document.documentElement.addEventListener('mouseleave', () => { soltar(atual); atual = null; if (mag) mag.style.translate = ''; mag = null; });

    document.addEventListener('pointerdown', e => {
        const b = e.target.closest('.btn, .conta-add');
        if (!b || reduzMovimento()) return;
        const r = b.getBoundingClientRect();
        const s = document.createElement('span');
        const tam = Math.max(r.width, r.height) * 2.2;
        s.className = 'ripple';
        Object.assign(s.style, { width: tam + 'px', height: tam + 'px', left: e.clientX - r.left - tam / 2 + 'px', top: e.clientY - r.top - tam / 2 + 'px' });
        b.appendChild(s);
        setTimeout(() => s.remove(), 700);
    });
}

async function irParaMes(m) {
    if (!m || m === state.mes) return;
    const stage = $('#stage');
    if (!reduzMovimento()) {
        stage.classList.add('leaving');
        await esperar(170);
    }
    state.mes = m;
    stage.classList.remove('leaving');
    const topo = $('#topoTxt');
    topo.classList.remove('rise'); void topo.offsetWidth; topo.classList.add('rise');
    renderAll(true);
    if (window.scrollY > 300) window.scrollTo({ top: 0, behavior: reduzMovimento() ? 'auto' : 'smooth' });
}

// =====================================================================
//  Ações (delegação)
// =====================================================================
const acoes = {
    'mes': el => irParaMes(el.dataset.mes),
    'novo-mes': () => abrirNovoMes(),
    'mes-alvo': el => {
        ctxMes.alvo = somarMeses(ctxMes.alvo, +el.dataset.d);
        renderNovoMes();
        $('#dlgNovoMes .nome').animate([{ opacity: 0, translate: `${el.dataset.d * 14}px 0` }, { opacity: 1, translate: '0 0' }], { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' });
    },
    'mes-conta': el => { el.checked ? ctxMes.contas.add(el.dataset.id) : ctxMes.contas.delete(el.dataset.id); renderNovoMes(); },
    'mes-fixas': el => { ctxMes.fixas = el.checked; renderNovoMes(); },
    'criar-mes': () => criarMes(),
    'conta': el => abrirConta(el.dataset.id),
    'conta-nova': () => {
        if (!state.mes) return abrirNovoMes();
        $('#contaSub').textContent = `Cartão, serviço ou despesa em ${state.mes}.`;
        abrir($('#dlgNovaConta'));
        setTimeout(() => $('#inContaNome').focus(), 60);
    },
    'conta-excluir': async el => {
        const f = acharFatura(el.dataset.id);
        if (!f) return;
        const ok = await confirmar({ titulo: `Excluir ${f.banco}?`, texto: `A conta e ${plural(itens(f).length, 'lançamento')} de ${f.mes} serão removidos. Você pode desfazer logo em seguida.`, sim: 'Excluir', perigo: true });
        if (!ok) return;
        fechar($('#dlgConta'));
        mutar(() => { state.dados = state.dados.filter(x => x !== f); }, { desfazer: `${f.banco} removida de ${f.mes}.` });
    },
    'item-novo': el => abrirItem(el.dataset.id),
    'item-editar': el => abrirItem(el.dataset.id, +el.dataset.i),
    'item-remover': el => {
        const f = acharFatura(el.dataset.id);
        const p = f && itens(f)[+el.dataset.i];
        if (!p) return;
        mutar(() => itens(f).splice(+el.dataset.i, 1), { desfazer: `Lançamento de ${brl(p.valor)} removido.` });
    },
    'toggle': el => {
        const f = acharFatura(el.dataset.id);
        const p = f && itens(f)[+el.dataset.i];
        if (!p) return;
        const vaiPagar = !pago(p);
        const r = el.getBoundingClientRect();
        const antes = statsMes(f.mes).pct;
        mutar(() => { p.status = vaiPagar ? 'ok' : 'pendente'; });
        if (vaiPagar) {
            burst(r.left + r.width / 2, r.top + r.height / 2, 12);
            flashItem(el.dataset.id, el.dataset.i);
            if (antes < .999 && statsMes(f.mes).pct >= .999) {
                setTimeout(() => burst(innerWidth / 2, innerHeight / 3, 60), 150);
                toast(`${f.mes} está 100% quitado!`, { tipo: 'ok' });
            }
        }
    },
    'pago-conta-pessoa': el => {
        const f = acharFatura(el.dataset.id);
        if (!f) return;
        const k = el.dataset.k;
        const r = el.getBoundingClientRect();
        mutar(() => itens(f).forEach(p => { if (norm(p.nome) === k) p.status = 'ok'; }), { desfazer: `${nomeDe(k)}: tudo pago em ${f.banco}.` });
        burst(r.left + r.width / 2, r.top + r.height / 2, 18);
    },
    'pessoa': el => abrirPessoa(el.dataset.k),
    'pessoa-pago': (el, e) => {
        e.stopPropagation();
        const k = el.dataset.k;
        const r = el.getBoundingClientRect();
        let n = 0;
        mutar(() => faturasEscopo().forEach(f => itens(f).forEach(p => { if (norm(p.nome) === k && !pago(p)) { p.status = 'ok'; n++; } })),
            { desfazer: `${nomeDe(k)}: pendências marcadas como pagas.` });
        if (n) burst(r.left + r.width / 2, r.top + r.height / 2, 22);
    },
    'whats-pessoa': (el, e) => { e.stopPropagation(); abrirEnvio(el.dataset.k, faturasEscopo()); },
    'whats-conta': el => abrirEnvio(el.dataset.k, [acharFatura(el.dataset.id)].filter(Boolean)),
    'envio-copiar': async () => { const ok = await copiar(ctxEnvio.cobranca.texto); toast(ok ? 'Mensagem copiada.' : 'Não consegui copiar.', { tipo: ok ? 'ok' : 'bad' }); },
    'envio-web': () => {
        copiar(ctxEnvio.cobranca.texto);
        abrirWhatsAppWeb($('#inTelEnvio').value.trim(), ctxEnvio.cobranca.texto);
        registrarCobranca(ctxEnvio.k, ctxEnvio.faturas, ctxEnvio.cobranca.total, 'web');
    },
    'envio-bot': el => enviarBot(el),
    'cobrar-todos': () => abrirLote(),
    'lote-enviar': el => enviarLote(el),
    'escopo': el => { state.escopo = el.dataset.v; renderReceber(); requestAnimationFrame(() => { $$('#receberCard [data-count]').forEach(contar); posSeg($('#escopo')); }); },
    'filtro': el => {
        state.filtro = el.dataset.v;
        $$('#filtro button').forEach(b => b.classList.toggle('on', b === el));
        posSeg($('#filtro'));
        ANIM = !reduzMovimento();
        renderContas();
    },
    'tema': () => {
        const novo = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        const aplicar = () => { document.documentElement.dataset.theme = novo; $('meta[name="theme-color"]').content = novo === 'light' ? '#f5efe2' : '#0b0a08'; };
        if (document.startViewTransition && !reduzMovimento()) document.startViewTransition(aplicar); else aplicar();
        lsSet('aurea.tema', novo);
    },
    'config': () => abrirConfig(),
    'sair': () => sair(),
    'fechar': el => fechar(el.closest('dialog')),

    // importar fatura
    'imp-abrir': el => abrirImport(el.dataset.id),
    'imp-ler': () => lerImport(),
    'imp-sem-arquivo': (el, e) => { e.preventDefault(); e.stopPropagation(); ctxImp.texto = ($('#impTexto') || {}).value || ''; ctxImp.arquivo = null; renderImport(); },
    'imp-voltar': () => { ctxImp.etapa = 'entrada'; renderImport(); },
    'imp-sel': el => {
        const l = ctxImp.linhas[+el.dataset.li];
        l.sel = el.checked;
        el.closest('.imp-row').classList.toggle('sel', l.sel);
        renderImpBar();
    },
    'imp-sel-todos': el => { ctxImp.linhas.forEach(l => { l.sel = el.checked; }); renderImpLista(); renderImpBar(); },
    'imp-pessoa': el => impAlternarPessoa(el.dataset.nome),
    'imp-tirar': el => {
        const l = ctxImp.linhas[+el.dataset.li];
        l.pessoas = l.pessoas.filter(p => norm(p) !== norm(el.dataset.nome));
        renderImpLista(); renderImpBar(); renderImpResumo();
    },
    'imp-incluir': el => { const l = ctxImp.linhas[+el.dataset.li]; l.incluir = !l.incluir; renderImpLista(); renderImpResumo(); },
    'imp-lancar': el => lancarImport(el),
};

// Põe a pessoa em todas as linhas selecionadas; se todas já têm, tira de todas.
function impAlternarPessoa(nome) {
    nome = String(nome || '').trim();
    const sel = ctxImp.linhas.filter(l => l.sel);
    if (!nome || !sel.length) return;
    const k = norm(nome);
    const todasTem = sel.every(l => l.pessoas.some(p => norm(p) === k));
    sel.forEach(l => {
        l.pessoas = todasTem ? l.pessoas.filter(p => norm(p) !== k) : (l.pessoas.some(p => norm(p) === k) ? l.pessoas : [...l.pessoas, nome]);
    });
    renderImpLista(); renderImpBar(); renderImpResumo();
}

function iniciarEventos() {
    document.addEventListener('click', e => {
        const el = e.target.closest('[data-act]');
        if (!el || el.disabled) return;
        if (el.type === 'checkbox') return; // tratados no 'change'
        const fn = acoes[el.dataset.act];
        if (fn) { if (el.tagName === 'A') e.preventDefault(); fn(el, e); }
    });
    document.addEventListener('change', e => {
        const el = e.target;
        if (el.type === 'checkbox' && el.dataset.act && acoes[el.dataset.act]) acoes[el.dataset.act](el, e);
        if (el.id === 'inTelPessoa') { salvarTel(el.dataset.k, el.dataset.nome, el.value).then(() => toast('Telefone salvo.', { tipo: 'ok' })); }
        if (el.id === 'impArquivo') lerArquivoImp(el.files[0]);
        if (el.id === 'impTotalFatura') { const v = parseValor(el.value); ctxImp.totalFatura = v > 0 ? v : 0; renderImpResumo(); }
    });
    document.addEventListener('input', e => {
        const el = e.target;
        if (!el.matches('.imp-in[data-campo]')) return;
        const l = ctxImp.linhas[+el.dataset.li];
        if (!l) return;
        if (el.dataset.campo === 'descricao') l.descricao = el.value;
        else { const v = parseValor(el.value); if (v > 0) { l.valor = v; renderImpResumo(); } }
    });
    document.addEventListener('keydown', e => {
        if (e.target.id === 'impNovaPessoa' && e.key === 'Enter') { e.preventDefault(); impAlternarPessoa(e.target.value); e.target.value = ''; }
    });
    document.addEventListener('dragover', e => {
        const z = e.target.closest?.('#impDrop');
        if (z) { e.preventDefault(); z.classList.add('sobre'); }
    });
    document.addEventListener('dragleave', e => { e.target.closest?.('#impDrop')?.classList.remove('sobre'); });
    document.addEventListener('drop', e => {
        const z = e.target.closest?.('#impDrop');
        if (!z) return;
        e.preventDefault();
        z.classList.remove('sobre');
        lerArquivoImp(e.dataTransfer.files[0]);
    });
    document.addEventListener('keydown', e => {
        const el = e.target;
        if (el.matches?.('.pessoa[role="button"]') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); el.click(); }
        const digitando = /INPUT|TEXTAREA|SELECT/.test(el.tagName);
        if (e.key === '/' && !digitando && !document.querySelector('dialog[open]')) { e.preventDefault(); $('#busca').focus(); }
    });

    let deb;
    $('#busca').addEventListener('input', e => {
        clearTimeout(deb);
        deb = setTimeout(() => { state.busca = e.target.value; ANIM = false; renderContas(); }, 160);
    });

    // formulário de lançamento
    $('#formItem').addEventListener('submit', salvarItem);
    $('#inPessoa').addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ',') && e.target.value.trim()) { e.preventDefault(); addChip(e.target.value); }
        else if (e.key === 'Enter') { e.preventDefault(); $('#inValor').focus(); }
        else if (e.key === 'Backspace' && !e.target.value && ctxItem.pessoas.length) { ctxItem.pessoas.pop(); renderChips(); }
    });
    $('#inPessoa').addEventListener('change', e => { if (e.target.value.trim() && todasPessoas().some(n => n === e.target.value)) addChip(e.target.value); });
    $('#inValor').addEventListener('input', atualizarDivisao);
    $('#chipsPessoas').addEventListener('click', e => {
        const b = e.target.closest('[data-chip]');
        if (b) { ctxItem.pessoas.splice(+b.dataset.chip, 1); renderChips(); }
        else $('#inPessoa').focus();
    });
    $('#sugPessoas').addEventListener('click', e => { const b = e.target.closest('[data-sug]'); if (b) addChip(b.dataset.sug); });

    $('#formConta').addEventListener('submit', criarConta);
    $('#formConfig').addEventListener('submit', salvarConfig);
    $('#formLogin').addEventListener('submit', entrar);

    let rz;
    addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { $$('.seg').forEach(posSeg); moverIndicadorMes(); }, 120); });
}

// ---------- Erros visíveis ----------
addEventListener('error', e => { if (!String(e.filename || '').startsWith('chrome-extension://')) console.error(e.error || e.message); });
addEventListener('unhandledrejection', e => console.error(e.reason));

// ---------- Início ----------
if (lsGet('aurea.motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';
iniciarDialogos();
iniciarEventos();
iniciarCursor();
carregar().catch(err => { console.error(err); toast(`Erro ao iniciar: ${err.message}`, { tipo: 'bad', duracao: 10000 }); });

})();

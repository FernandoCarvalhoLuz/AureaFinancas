// Agente de lançamentos financeiros pelo grupo de WhatsApp.
//
// Fluxo: o usuário manda texto, áudio, foto ou PDF → a IA monta/ajusta um rascunho e
// pergunta o que falta (mês, conta, pessoas, valor, parcelamento) → quando o CÓDIGO vê
// que está completo, mostra o resumo exato do que será gravado → só um "OK" do usuário
// grava, via POST /api/lancamentos no servidor de finanças (que só acrescenta, nunca regrava).
const ia = require('./financas-ia');

const TTL_MS = 30 * 60 * 1000;        // rascunho esquecido some depois de meia hora
const HISTORICO_MAX = 12;
const RE_OK = /^(ok|okay|okk|sim|s|confirmo|confirma|confirmado|pode lan[çc]ar|lan[çc]a|pode|isso|certo|perfeito|👍|✅)[.! ]*$/i;
// "não" fica de fora de propósito: é resposta normal para "é parcelado?".
const RE_CANCELAR = /^(cancela|cancelar|cancelado|esquece|esquece isso|deixa pra l[áa]|desisto|n[ãa]o lan[çc]a)[.! ]*$/i;

/**
 * Cliente do servidor de finanças (o mesmo que serve a página).
 * @param {object} p
 * @param {string} p.baseUrl   ex.: http://127.0.0.1:8080
 * @param {string} p.apiKey
 */
function criarApiFinancas({ baseUrl, apiKey, fetch: buscar = globalThis.fetch, timeoutMs = 15000 }) {
  const raiz = String(baseUrl || '').replace(/\/+$/, '');
  async function chamar(caminho, opcoes = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await buscar(`${raiz}${caminho}`, {
        ...opcoes,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, ...(opcoes.headers || {}) },
        signal: ctrl.signal,
      });
      const corpo = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(corpo.error || `servidor de finanças respondeu ${res.status}`);
      return corpo;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    faturas: () => chamar('/api/financas'),
    lancar: (lancamentos, mesesNovos = []) => chamar('/api/lancamentos', { method: 'POST', body: JSON.stringify({ lancamentos, mesesNovos }) }),
  };
}

/**
 * @param {object} p
 * @param {object} p.ai       motor com gerarJson
 * @param {object} p.api      criarApiFinancas(...)
 * @param {Function} p.send   (jid, texto) => Promise
 * @param {object} [p.log]
 * @param {Function} [p.agora]  () => Date, injetável nos testes
 * @param {string} [p.urlPagina] link da página, mostrado depois de lançar
 */
function criarAgenteFinancas({ ai, api, send, log = null, agora = () => new Date(), urlPagina = '' }) {
  // Um estado por grupo (na prática só existe um grupo de finanças).
  const estados = new Map();

  function estadoDe(jid) {
    const e = estados.get(jid);
    if (e && agora().getTime() - e.atualizadoEm <= TTL_MS) return e;
    const novo = { historico: [], rascunho: [], prontos: null, atualizadoEm: agora().getTime() };
    estados.set(jid, novo);
    return novo;
  }
  const zerar = (jid) => estados.delete(jid);

  function registrar(e, fala, resposta) {
    e.historico.push({ role: 'user', content: fala }, { role: 'assistant', content: resposta });
    if (e.historico.length > HISTORICO_MAX) e.historico = e.historico.slice(-HISTORICO_MAX);
    e.atualizadoEm = agora().getTime();
  }

  async function lancar(jid, e) {
    const grupos = ia.paraApi(e.prontos);
    const mesesNovos = ia.mesesNovosDe(e.prontos);
    try {
      const r = await api.lancar(grupos, mesesNovos);
      zerar(jid);
      const qtd = grupos.reduce((s, g) => s + g.itens.length, 0);
      const onde = (r.resumo || grupos).map((g) => `${g.banco} · ${g.mes}`).join(', ');
      const criados = Array.isArray(r.mesesCriados) ? r.mesesCriados : [];
      if (log) log.info({ grupos: grupos.length, itens: qtd, revisao: r.revisao, mesesCriados: criados }, 'lançamentos gravados pelo WhatsApp');
      return send(jid, [
        criados.length ? `🗓️ ${criados.length === 1 ? 'Mês criado' : 'Meses criados'}: ${criados.join(', ')}.` : '',
        `✅ Lançado! ${qtd === 1 ? '1 item' : `${qtd} itens`} em ${onde}.`,
        urlPagina,
      ].filter(Boolean).join('\n'));
    } catch (err) {
      if (log) log.error({ err }, 'falha ao gravar lançamentos');
      return send(jid, `⚠️ Não consegui gravar: ${err.message}\nO rascunho continua aqui — responda OK para tentar de novo.`);
    }
  }

  async function handleMessage(msg) {
    const jid = msg.chatJid;
    const texto = String(msg.text || '').trim();
    const e = estadoDe(jid);

    // 1) Confirmação explícita: única porta para gravar.
    if (e.prontos && RE_OK.test(texto) && !msg.audio && !msg.anexo) return lancar(jid, e);

    // 2) Desistência
    if (RE_CANCELAR.test(texto) && !msg.audio && !msg.anexo && (e.rascunho.length || e.prontos)) {
      zerar(jid);
      return send(jid, '👍 Cancelado, nada foi lançado.');
    }

    if (!ai || typeof ai.gerarJson !== 'function') return send(jid, '⚠️ Motor de IA indisponível no servidor.');

    let ctx;
    try {
      ctx = ia.montarContexto(await api.faturas());
    } catch (err) {
      if (log) log.error({ err }, 'servidor de finanças inacessível');
      return send(jid, `⚠️ Não consegui ler a plataforma de finanças agora (${err.message}).`);
    }

    const anexos = [msg.audio, msg.anexo].filter((a) => a && a.buffer);
    const tipoAnexo = msg.audio ? '(mensagem de voz anexada)' : msg.anexo ? '(documento/imagem anexado)' : '';
    const fala = `${msg.autor ? `[${msg.autor}] ` : ''}${[texto, tipoAnexo].filter(Boolean).join(' ')}`.trim();
    const hoje = agora().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

    let saida;
    try {
      saida = await ai.gerarJson({
        systemInstruction: ia.instrucaoAgente(ctx, e.rascunho, hoje),
        mensagens: [...e.historico, { role: 'user', content: fala }],
        anexos,
        schema: ia.SCHEMA_TURNO,
        temperature: 0,
        rotulo: 'financas',
      });
    } catch (err) {
      if (log) log.error({ err }, 'falha no motor de IA (finanças)');
      return send(jid, '⚠️ Não consegui processar agora. Tente de novo em instantes.');
    }
    if (!saida) return send(jid, '⚠️ Não entendi. Pode mandar de outro jeito?');

    if (saida.intencao === 'cancelar') {
      zerar(jid);
      return send(jid, '👍 Cancelado, nada foi lançado.');
    }

    const lancs = Array.isArray(saida.lancamentos) ? saida.lancamentos : [];
    if (saida.intencao === 'conversar' && !lancs.length) {
      const r = saida.resposta || 'Pode mandar o gasto: valor, conta, quem paga e se é parcelado.';
      registrar(e, fala, r);
      return send(jid, r);
    }

    e.rascunho = lancs;
    const normalizados = lancs.map((l) => ia.normalizarLancamento(l, ctx));
    const falta = normalizados.length ? ia.perguntaFaltas(normalizados) : 'Não achei nenhum gasto na mensagem. Me diz o valor, a conta e quem paga.';

    let resposta;
    if (falta) {
      e.prontos = null;
      // A pergunta do modelo costuma ser mais natural; a nossa garante que nada fique de
      // fora. Se o modelo não perguntou nada, a nossa vai junto.
      const doModelo = String(saida.resposta || '').trim();
      resposta = doModelo.includes('?') ? doModelo : [doModelo, falta].filter(Boolean).join('\n');
    } else {
      e.prontos = normalizados;
      resposta = ia.resumoConfirmacao(normalizados, ctx);
    }
    registrar(e, fala, resposta);
    if (log) log.info({ lancamentos: lancs.length, completo: !falta }, 'turno do agente de finanças');
    return send(jid, resposta);
  }

  return { handleMessage, _estados: estados };
}

module.exports = { criarAgenteFinancas, criarApiFinancas, RE_OK, RE_CANCELAR, TTL_MS };

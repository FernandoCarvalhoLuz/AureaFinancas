// Lógica do módulo de finanças que não depende de rede: prompts, schemas, validação do
// rascunho, divisão de valores e o texto de confirmação. Fica separada do agente
// (src/financas-agente.js) para ser testada sem WhatsApp, sem IA e sem servidor.
//
// Regra de ouro: a IA só PROPÕE. Quem decide se o rascunho está completo é o código
// daqui, e quem manda gravar é o "OK" do usuário — nunca o modelo.
'use strict';

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
// Configuração da instalação (.env), a mesma que o servidor da página usa.
const ANO_BASE = Number(process.env.ANO_BASE || 2026); // meses gravados sem ano ("Agosto") pertencem a este ano
const NOMES_EU_ORIGINAIS = String(process.env.NOMES_EU || 'Eu').split(',').map((s) => s.trim()).filter(Boolean);
const NOME_DONO = NOMES_EU_ORIGINAIS.find((n) => n.toLowerCase() !== 'eu') || NOMES_EU_ORIGINAIS[0] || 'Eu';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
const NOMES_EU = NOMES_EU_ORIGINAIS.map(norm);
const brl =(v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function ordemMes(rotulo) {
  const [nome, ano] = String(rotulo ?? '').trim().split(/\s+/);
  const idx = MESES.indexOf(nome);
  if (idx < 0) return 1e9;
  return (/^\d{4}$/.test(ano || '') ? Number(ano) : ANO_BASE) * 12 + idx;
}
const rotuloDe = (idx, ano) => (ano === ANO_BASE ? MESES[idx] : `${MESES[idx]} ${ano}`);
function somarMeses(rotulo, n) {
  const o = ordemMes(rotulo) + n;
  return rotuloDe(((o % 12) + 12) % 12, Math.floor(o / 12));
}

// Quantos meses à frente do mais recente o WhatsApp pode criar de uma vez.
const MAX_MESES_NOVOS = 3;

/**
 * Entende o mês dito pelo usuário ("outubro", "Janeiro de 2027", "jan/27") e decide:
 * mês que já existe → usa; mês depois do mais recente → cria (e os do meio, em ordem,
 * para as parcelas não pularem); mês "buraco" no passado → recusa.
 * @returns {{ mes: string, criar: string[] } | { erro: string }}
 */
function resolverMes(texto, ctx) {
  const t = norm(texto);
  if (!t) return { erro: 'o mês' };
  const exato = ctx.meses.find((m) => norm(m) === t);
  if (exato) return { mes: exato, criar: [] };
  const idx = MESES.findIndex((m) => t.startsWith(norm(m).slice(0, 3)));
  if (idx < 0) return { erro: `o mês (não entendi "${texto}")` };
  const anoM = t.match(/\b(20\d{2})\b/) || t.match(/[\/\s'](\d{2})$/);
  let rotulo;
  if (anoM) {
    rotulo = rotuloDe(idx, anoM[1].length === 2 ? 2000 + Number(anoM[1]) : Number(anoM[1]));
  } else {
    // sem ano: o mês com esse nome que já existe; senão, o mais próximo do mês mais recente
    // ("agosto" em outubro é o de 2 meses atrás; "janeiro" em outubro é o próximo). Empate → futuro.
    rotulo = ctx.meses.filter((m) => m.split(' ')[0] === MESES[idx]).pop();
    if (!rotulo) {
      const ref = ctx.mesAtual ? ordemMes(ctx.mesAtual) : ANO_BASE * 12 + idx;
      const anoRef = Math.floor(ref / 12);
      rotulo = [anoRef - 1, anoRef, anoRef + 1]
        .map((a) => ({ r: rotuloDe(idx, a), d: a * 12 + idx - ref }))
        .sort((x, y) => Math.abs(x.d) - Math.abs(y.d) || y.d - x.d)[0].r;
    }
  }
  if (ctx.meses.includes(rotulo)) return { mes: rotulo, criar: [] };
  if (!ctx.mesAtual) return { mes: rotulo, criar: [rotulo] };
  const distancia = ordemMes(rotulo) - ordemMes(ctx.mesAtual);
  if (distancia <= 0) return { erro: `o mês (${rotulo} não existe na plataforma e fica antes de ${ctx.mesAtual}; escolha outro)` };
  if (distancia > MAX_MESES_NOVOS) return { erro: `o mês (${rotulo} está longe demais; posso criar no máximo até ${somarMeses(ctx.mesAtual, MAX_MESES_NOVOS)})` };
  return { mes: rotulo, criar: Array.from({ length: distancia }, (_, i) => somarMeses(ctx.mesAtual, i + 1)) };
}

// ---------- Contexto (o que o modelo precisa saber dos dados) ----------

/** Resume as faturas do servidor no que o agente e o prompt usam. */
function montarContexto(faturas) {
  const meses = [...new Set(faturas.map((f) => f.mes))].sort((a, b) => ordemMes(a) - ordemMes(b));
  const mesAtual = meses[meses.length - 1] || null;
  const contasPorMes = {};
  for (const m of meses) contasPorMes[m] = faturas.filter((f) => f.mes === m).map((f) => f.banco);

  // pessoas: das mais recentes para as mais antigas, sem repetir variações de grafia
  const pessoas = new Map();
  for (const m of meses.slice().reverse()) {
    for (const f of faturas.filter((x) => x.mes === m)) {
      for (const p of f.pessoas || []) if (p && p.nome && !pessoas.has(norm(p.nome))) pessoas.set(norm(p.nome), p.nome);
    }
  }

  const pendencias = new Map();
  for (const f of faturas.filter((x) => x.mes === mesAtual)) {
    for (const p of f.pessoas || []) {
      if (!p || p.status === 'ok' || NOMES_EU.includes(norm(p.nome))) continue;
      const k = norm(p.nome);
      const o = pendencias.get(k) || { nome: p.nome, total: 0 };
      o.total += Number(p.valor) || 0;
      pendencias.set(k, o);
    }
  }

  return {
    meses,
    mesAtual,
    contasPorMes,
    pessoas: [...pessoas.values()],
    pendencias: [...pendencias.values()].sort((a, b) => b.total - a.total),
  };
}

// ---------- Agente: schema e prompt ----------

// Todos os campos obrigatórios, com valores-sentinela ("" e 0) para "não informado":
// com saída restrita, campo opcional é campo que o modelo pula (lição aprendida com modelos pequenos).
const SCHEMA_TURNO = {
  type: 'object',
  properties: {
    intencao: { type: 'string', enum: ['lancar', 'cancelar', 'conversar'] },
    resposta: { type: 'string', description: 'Mensagem curta ao usuário, sem markdown: a pergunta sobre o que falta, ou a resposta a uma pergunta.' },
    lancamentos: {
      type: 'array',
      description: 'O rascunho COMPLETO e atualizado: todos os lançamentos em discussão, inclusive os combinados em mensagens anteriores.',
      items: {
        type: 'object',
        properties: {
          mes: { type: 'string', description: 'Um dos meses existentes, escrito igual à lista; "" se não informado' },
          banco: { type: 'string', description: 'Conta, cartão ou área. Use o nome exato da lista quando corresponder; "" se não informado' },
          pessoas: { type: 'array', items: { type: 'string' }, description: 'Quem paga. Vários nomes = o valor é dividido igualmente. [] se não informado' },
          valor: { type: 'number', description: 'Valor em reais; 0 se não informado' },
          tipoValor: { type: 'string', enum: ['parcela', 'total_da_compra', 'unico'], description: 'parcela = já é o valor de cada parcela; total_da_compra = valor cheio de uma compra parcelada; unico = compra à vista' },
          descricao: { type: 'string', description: 'O que foi comprado; "" se não informado' },
          parcelamento: { type: 'string', enum: ['a_vista', 'parcelado', 'nao_informado'] },
          totalParcelas: { type: 'integer', description: 'Número de parcelas; 0 se à vista ou não informado' },
          parcelaAtual: { type: 'integer', description: 'Qual parcela entra neste mês; 0 se não informado (será 1)' },
        },
        required: ['mes', 'banco', 'pessoas', 'valor', 'tipoValor', 'descricao', 'parcelamento', 'totalParcelas', 'parcelaAtual'],
      },
    },
  },
  required: ['intencao', 'resposta', 'lancamentos'],
};

function instrucaoAgente(ctx, rascunho, hoje) {
  const contas = ctx.meses.slice(-3).map((m) => `- ${m}: ${(ctx.contasPorMes[m] || []).join(', ') || '(nenhuma conta)'}`).join('\n');
  const pend = ctx.pendencias.length
    ? ctx.pendencias.map((p) => `${p.nome} ${brl(p.total)}`).join('; ')
    : 'ninguém com pendência';
  return [
    'Você é o assistente de lançamentos financeiros da casa, num grupo de WhatsApp, em português do Brasil.',
    'Seu trabalho: transformar o que o usuário manda (texto, áudio, foto de comprovante, nota ou fatura) em lançamentos para a plataforma Áurea.',
    `Hoje é ${hoje}. Mês mais recente na plataforma: ${ctx.mesAtual || '(nenhum)'}.`,
    '',
    'Cada lançamento precisa de: MÊS, CONTA (banco/cartão/área), PESSOA(S) que pagam, VALOR, e se é À VISTA ou PARCELADO (com quantas parcelas).',
    '',
    'Regras:',
    '- Nunca invente valor, nome, conta ou parcelamento. O que não foi dito fica vazio ("" / 0 / []) e você pergunta.',
    '- Se o usuário não disser se é parcelado ou à vista, parcelamento = "nao_informado" e PERGUNTE.',
    `- Se o mês não for dito, use "${ctx.mesAtual || ''}" (o usuário confirma no resumo final).`,
    `- O usuário pode citar um mês que ainda não existe e vem depois de ${ctx.mesAtual || 'hoje'} (ex.: "lança em outubro"): escreva esse mês (com o ano se não for ${ANO_BASE}, ex.: "Janeiro 2027"). O sistema cria o mês sozinho e avisa no resumo.`,
    '- "Dividir com X" ou vários nomes: coloque todos em pessoas; o sistema divide o valor igualmente.',
    `- Quem escreve "eu", "meu", "gastei" fala de si mesmo: use o nome do autor da mensagem quando ele aparecer entre colchetes e estiver na lista de pessoas; se o autor for o dono da conta (${NOME_DONO}) ou não aparecer, use "${NOME_DONO}".`,
    '- Prefira nomes de pessoas e contas exatamente como aparecem nas listas abaixo (ex.: "santander" → "SANTANDER").',
    '- Parcelado com o valor cheio da compra ("tênis de 300 em 3x"): valor = 300 e tipoValor = "total_da_compra". Se disser o valor da parcela ("3x de 100"): valor = 100, tipoValor = "parcela".',
    '- Foto ou PDF de comprovante/fatura: leia valores, estabelecimento, data e parcelas do documento. Pergunte quem paga e em qual conta, se não estiver claro.',
    '- Devolva SEMPRE a lista completa do rascunho, mantendo o que já foi combinado e aplicando as correções da última mensagem.',
    '- intencao "cancelar" se o usuário desistir; "conversar" para perguntas ou papo (responda curto usando as pendências abaixo quando servir); senão "lancar".',
    '- Na resposta, pergunte TUDO o que falta de uma vez, em no máximo 3 linhas. Não peça confirmação final: o sistema monta o resumo e pede o OK sozinho.',
    '- Nunca diga que lançou ou gravou algo: só o sistema grava, depois do OK do usuário.',
    '',
    `Meses existentes: ${ctx.meses.join(', ') || '(nenhum)'}`,
    'Contas dos meses mais recentes:',
    contas || '(nenhuma)',
    `Pessoas conhecidas: ${ctx.pessoas.join(', ') || '(nenhuma)'}`,
    `Pendências em ${ctx.mesAtual}: ${pend}`,
    '',
    `Rascunho atual: ${rascunho && rascunho.length ? JSON.stringify(rascunho) : '(vazio)'}`,
  ].join('\n');
}

// ---------- Validação e normalização (decisão do código, não do modelo) ----------

function acharNome(lista, nome) {
  const n = norm(nome);
  if (!n) return null;
  return lista.find((x) => norm(x) === n) || null;
}

/** Divide um valor em centavos; a sobra vai para o primeiro (mesma regra da página). */
function dividir(valor, partes) {
  const cents = Math.round(Number(valor) * 100);
  const base = Math.floor(cents / partes);
  return Array.from({ length: partes }, (_, i) => (base + (i === 0 ? cents - base * partes : 0)) / 100);
}

/**
 * Transforma o lançamento proposto pelo modelo no que será gravado, e lista o que falta.
 * @returns {{ faltas: string[], mes, banco, contaNova, descricao, parcelaAtual, totalParcelas, valorParcela, itens: [{nome, valor, pessoaNova}] }}
 */
function normalizarLancamento(l, ctx) {
  const faltas = [];
  const rm = resolverMes(l.mes, ctx);
  const mes = rm.erro ? null : rm.mes;
  const mesesNovos = rm.erro ? [] : rm.criar;
  if (rm.erro) faltas.push(rm.erro);

  // mês que será criado herda as contas do mais recente
  const contasDoMes = mes ? ctx.contasPorMes[mes] || (mesesNovos.length ? ctx.contasPorMes[ctx.mesAtual] || [] : []) : [];
  const banco = l.banco ? (acharNome(contasDoMes, l.banco) || String(l.banco).trim()) : '';
  if (!banco) faltas.push('a conta (banco, cartão ou área)');

  const pessoas = (Array.isArray(l.pessoas) ? l.pessoas : []).map((p) => String(p).trim()).filter(Boolean);
  if (!pessoas.length) faltas.push('quem paga');

  const valor = Math.round(Number(l.valor) * 100) / 100;
  if (!(valor > 0)) faltas.push('o valor');

  let totalParcelas = null;
  let parcelaAtual = null;
  if (l.parcelamento === 'nao_informado' || !l.parcelamento) faltas.push('se é à vista ou parcelado');
  else if (l.parcelamento === 'parcelado') {
    totalParcelas = Number.isInteger(l.totalParcelas) && l.totalParcelas >= 2 ? l.totalParcelas : null;
    if (!totalParcelas) faltas.push('em quantas parcelas');
    else parcelaAtual = Number.isInteger(l.parcelaAtual) && l.parcelaAtual >= 1 && l.parcelaAtual <= totalParcelas ? l.parcelaAtual : 1;
  }

  const valorParcela = totalParcelas && l.tipoValor === 'total_da_compra'
    ? Math.round((valor / totalParcelas) * 100) / 100
    : valor;
  const vistos = new Set();
  const nomes = pessoas
    .map((p) => acharNome(ctx.pessoas, p) || p)
    .filter((p) => !vistos.has(norm(p)) && vistos.add(norm(p)));
  const valores = nomes.length && valorParcela > 0 ? dividir(valorParcela, nomes.length) : [];

  return {
    faltas,
    mes,
    mesesNovos,
    banco,
    contaNova: Boolean(banco && mes && !acharNome(contasDoMes, banco)),
    descricao: String(l.descricao || '').trim(),
    parcelaAtual,
    totalParcelas,
    valorParcela,
    valorCompra: totalParcelas && l.tipoValor === 'total_da_compra' ? valor : null,
    itens: nomes.map((nome, i) => ({ nome, valor: valores[i], pessoaNova: !acharNome(ctx.pessoas, nome) })),
  };
}

function perguntaFaltas(normalizados) {
  const faltas = [...new Set(normalizados.flatMap((n) => n.faltas))];
  if (!faltas.length) return null;
  const lista = faltas.length === 1 ? faltas[0] : `${faltas.slice(0, -1).join(', ')} e ${faltas[faltas.length - 1]}`;
  return `Pra lançar, me diz ${lista}.`;
}

/** Todos os meses a criar, sem repetir, em ordem. */
function mesesNovosDe(normalizados) {
  return [...new Set(normalizados.flatMap((n) => n.mesesNovos || []))].sort((a, b) => ordemMes(a) - ordemMes(b));
}

/** Texto do resumo que o usuário confirma com OK. Montado em código: o que aparece aqui é exatamente o que será gravado. */
function resumoConfirmacao(normalizados, ctx = null) {
  const novos = mesesNovosDe(normalizados);
  const avisoMes = novos.length
    ? `🆕 Vou criar ${novos.length === 1 ? 'o mês' : 'os meses'} *${novos.join(', ')}*${ctx && ctx.mesAtual ? `, com as contas de ${ctx.mesAtual}, parcelas avançadas e valores fixos repetidos (como o "Novo mês" da página)` : ''}.`
    : '';
  const blocos = normalizados.map((n, i) => {
    const parc = n.totalParcelas ? ` (parcela ${n.parcelaAtual}/${n.totalParcelas})` : ' (à vista)';
    const compra = n.valorCompra ? ` — compra de ${brl(n.valorCompra)}` : '';
    const pessoas = n.itens.map((it) => `${it.nome}${it.pessoaNova ? ' (nova)' : ''} ${brl(it.valor)}`).join(' · ');
    return [
      `*${normalizados.length > 1 ? `${i + 1}. ` : ''}${n.banco}*${n.contaNova ? ' (conta nova)' : ''} · ${n.mes}`,
      `   ${n.descricao || 'Sem descrição'} — ${brl(n.valorParcela)}${parc}${compra}`,
      `   👥 ${pessoas}`,
    ].join('\n');
  });
  const total = normalizados.reduce((s, n) => s + n.valorParcela, 0);
  return [
    '📝 *Confere o lançamento:*',
    '',
    avisoMes,
    avisoMes ? '' : null,
    blocos.join('\n\n'),
    normalizados.length > 1 ? `\nTotal: *${brl(total)}*` : '',
    '',
    'Responda *OK* para lançar, ou me diga o que mudar.',
  ].filter((l) => l !== null).filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

/** Agrupa por mês+conta no formato do POST /api/lancamentos do servidor de finanças. */
function paraApi(normalizados) {
  const grupos = new Map();
  for (const n of normalizados) {
    const k = `${n.mes}|${norm(n.banco)}`;
    if (!grupos.has(k)) grupos.set(k, { mes: n.mes, banco: n.banco, itens: [] });
    for (const it of n.itens) {
      grupos.get(k).itens.push({
        nome: it.nome,
        valor: it.valor,
        descricao: n.descricao,
        parcelaAtual: n.parcelaAtual,
        totalParcelas: n.totalParcelas,
        status: 'pendente',
        origem: 'whatsapp',
      });
    }
  }
  return [...grupos.values()];
}

// ---------- Leitura de fatura (página e WhatsApp) ----------

const SCHEMA_FATURA = {
  type: 'object',
  properties: {
    banco: { type: 'string', description: 'Banco, cartão ou loja que emitiu a fatura; "" se não aparecer' },
    totalFatura: { type: 'number', description: 'Valor total da fatura; 0 se não aparecer' },
    itens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          data: { type: 'string', description: 'Data da compra como aparece (DD/MM); "" se não houver' },
          descricao: { type: 'string', description: 'Estabelecimento ou descrição, sem o trecho de parcela' },
          valor: { type: 'number', description: 'Valor da linha em reais, positivo. Em compra parcelada é o valor da PARCELA deste mês.' },
          parcelaAtual: { type: 'integer', description: 'Ex.: 2 em "02/05"; 0 se não for parcelado' },
          totalParcelas: { type: 'integer', description: 'Ex.: 5 em "02/05"; 0 se não for parcelado' },
          credito: { type: 'boolean', description: 'true para estorno, crédito ou devolução (abate da fatura)' },
        },
        required: ['data', 'descricao', 'valor', 'parcelaAtual', 'totalParcelas', 'credito'],
      },
    },
  },
  required: ['banco', 'totalFatura', 'itens'],
};

const INSTRUCAO_FATURA = [
  'Você extrai lançamentos de faturas de cartão, extratos e listas de cobranças em português do Brasil.',
  'Liste CADA compra ou cobrança como um item, na ordem em que aparece. Não agrupe, não some e não pule linhas.',
  'NÃO inclua: pagamento da fatura anterior, saldo anterior, limite, total, encargos informativos, IOF de resumo, anuidade zerada.',
  'Inclua IOF, juros, anuidade ou tarifa apenas se aparecerem como lançamento cobrado com valor.',
  'Parcelas aparecem como "02/05", "PARC 2/5", "2 de 5": parcelaAtual=2, totalParcelas=5, e a descrição fica sem esse trecho.',
  'Valores no formato brasileiro: "1.234,56" = 1234.56. Estornos e créditos: credito=true, valor positivo.',
  'Se for uma lista informal (ex.: "uber 23,50 / mercado 120"), cada linha com valor vira um item.',
  'Nunca invente itens nem valores que não estão no documento.',
].join('\n');

function normalizarFatura(bruto) {
  const itens = (bruto && Array.isArray(bruto.itens) ? bruto.itens : [])
    .map((i) => {
      const valor = Math.round(Math.abs(Number(i.valor)) * 100) / 100;
      const tot = Number.isInteger(i.totalParcelas) && i.totalParcelas >= 2 ? i.totalParcelas : null;
      const atual = tot && Number.isInteger(i.parcelaAtual) && i.parcelaAtual >= 1 ? Math.min(i.parcelaAtual, tot) : null;
      return {
        data: String(i.data || '').trim(),
        descricao: String(i.descricao || '').trim(),
        valor,
        parcelaAtual: tot ? atual || 1 : null,
        totalParcelas: tot,
        credito: Boolean(i.credito),
      };
    })
    .filter((i) => i.valor > 0);
  return {
    banco: String((bruto && bruto.banco) || '').trim(),
    totalFatura: Math.round(Math.abs(Number(bruto && bruto.totalFatura) || 0) * 100) / 100,
    itens,
  };
}

/**
 * Lê uma fatura (texto colado, imagem ou PDF) e devolve os itens normalizados.
 * @param {object} p
 * @param {object} p.ai        motor com gerarJson
 * @param {string} [p.texto]
 * @param {{buffer: Buffer, mimeType: string}} [p.arquivo]
 */
async function extrairFatura({ ai, texto, arquivo, onUso }) {
  if (!ai || typeof ai.gerarJson !== 'function') throw new Error('Motor de IA sem suporte a leitura de faturas.');
  const pedido = [
    'Extraia os lançamentos.',
    texto && texto.trim() ? `\nConteúdo colado pelo usuário:\n${texto.trim().slice(0, 30000)}` : '',
    arquivo ? '\n(O documento está anexado.)' : '',
  ].join('');
  const bruto = await ai.gerarJson({
    systemInstruction: INSTRUCAO_FATURA,
    mensagens: [{ role: 'user', content: pedido }],
    anexos: arquivo ? [arquivo] : [],
    schema: SCHEMA_FATURA,
    temperature: 0,
    onUso,
    rotulo: 'fatura',
  });
  if (!bruto) throw new Error('A IA não conseguiu ler a fatura.');
  return normalizarFatura(bruto);
}

module.exports = {
  MESES,
  NOMES_EU,
  NOME_DONO,
  SCHEMA_TURNO,
  SCHEMA_FATURA,
  INSTRUCAO_FATURA,
  norm,
  brl,
  ordemMes,
  somarMeses,
  resolverMes,
  mesesNovosDe,
  MAX_MESES_NOVOS,
  montarContexto,
  instrucaoAgente,
  dividir,
  normalizarLancamento,
  perguntaFaltas,
  resumoConfirmacao,
  paraApi,
  normalizarFatura,
  extrairFatura,
};

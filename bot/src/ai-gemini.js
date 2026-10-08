// Motor de IA via API do Gemini (Google AI Studio): saída estruturada (JSON) com anexos.
// fetch direto, com timeout e retentativas nossas: o SDK já travou em produção sem timeout.
'use strict';

const PADRAO_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const PADRAO_MODELO = 'gemini-3.1-flash-lite';
const PADRAO_TIMEOUT_MS = 90000;
const PADRAO_TENTATIVAS = 3;

// 503 "high demand" e 429 são passageiros no Gemini: repetir resolve, desistir na primeira não.
const HTTP_TRANSITORIO = new Set([408, 429, 500, 502, 503, 504]);

/** Mensagens no formato {role, content} viram contents do Gemini. */
function paraContents(mensagens) {
  return (mensagens || [])
    .filter((m) => m && m.content)
    .map((m) => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(m.content) }],
    }));
}

function textoDaResposta(data) {
  const partes = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!Array.isArray(partes)) return null;
  const texto = partes.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
  return texto || null;
}

function createAiGemini({
  apiKey,
  model = PADRAO_MODELO,
  baseUrl = PADRAO_BASE_URL,
  timeoutMs = PADRAO_TIMEOUT_MS,
  tentativas = PADRAO_TENTATIVAS,
  log = null,
  esperar = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetch: buscar = globalThis.fetch,
} = {}) {
  const raiz = baseUrl.replace(/\/+$/, '');

  async function chamar(corpo) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await buscar(`${raiz}/models/${model}:generateContent`, {
        method: 'POST',
        // chave no cabeçalho, não na URL: query string vaza em log de proxy
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(corpo),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const texto = await res.text().catch(() => '');
        const err = new Error(`Gemini HTTP ${res.status}: ${texto.slice(0, 300)}`);
        err.status = res.status;
        err.transitorio = HTTP_TRANSITORIO.has(res.status);
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError' || err.cause) err.transitorio = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function chamarComRetentativa(corpo, rotulo) {
    let ultimo = null;
    for (let i = 1; i <= Math.max(1, tentativas); i += 1) {
      try {
        return await chamar(corpo);
      } catch (err) {
        ultimo = err;
        if (!err.transitorio || i >= tentativas) break;
        const espera = Math.round(400 * 2 ** (i - 1) * (1 + Math.random()));
        if (log) log.warn({ tentativa: i, espera, erro: err.message }, `${rotulo}: falha passageira no Gemini, repetindo`);
        await esperar(espera);
      }
    }
    throw ultimo;
  }

  return {
    nome: `gemini:${model}`,

    /**
     * Saída estruturada. Anexos (imagem, PDF, áudio) vão junto da última fala do usuário:
     * o Gemini lê os três direto. Devolve o objeto parseado, ou null se não veio JSON válido.
     */
    async gerarJson({ systemInstruction, mensagens, anexos = [], schema, temperature = 0, maxTokens, rotulo = 'json' }) {
      const contents = paraContents(mensagens);
      if (!contents.length) return null;
      const partesAnexo = anexos
        .filter((a) => a && a.buffer)
        .map((a) => ({ inlineData: { mimeType: a.mimeType || 'application/octet-stream', data: a.buffer.toString('base64') } }));
      if (partesAnexo.length) {
        const ultima = contents[contents.length - 1];
        ultima.parts = [...partesAnexo, ...ultima.parts];
      }
      const corpo = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature },
      };
      if (maxTokens) corpo.generationConfig.maxOutputTokens = maxTokens;
      const data = await chamarComRetentativa(corpo, rotulo);
      try {
        return JSON.parse(String(textoDaResposta(data) || '').trim());
      } catch {
        return null;
      }
    },
  };
}

module.exports = { createAiGemini, paraContents, textoDaResposta, PADRAO_MODELO };

// Motor de IA via API da OpenAI: saída estruturada (JSON) com anexos.
// Imagem vai como image_url, PDF como file, e áudio é transcrito antes e entra como texto.
'use strict';

const PADRAO_BASE_URL = 'https://api.openai.com/v1';
const PADRAO_MODELO = 'gpt-5.4-mini';
const PADRAO_MODELO_AUDIO = 'gpt-4o-transcribe';
const PADRAO_TIMEOUT_MS = 90000;

// O modo estrito exige todas as propriedades em `required` e additionalProperties false;
// campo opcional vira "tipo ou null". Convertemos o schema em vez de manter duas cópias.
function paraSchemaEstrito(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.type === 'array') return { ...schema, items: paraSchemaEstrito(schema.items) };
  if (schema.type !== 'object' || !schema.properties) return schema;
  const properties = {};
  for (const [nome, def] of Object.entries(schema.properties)) {
    const convertido = paraSchemaEstrito(def);
    const obrigatorio = (schema.required || []).includes(nome);
    properties[nome] = obrigatorio || Array.isArray(convertido.type) || convertido.enum
      ? convertido
      : { ...convertido, type: [convertido.type, 'null'] };
  }
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function createAiOpenAI({
  apiKey,
  model = PADRAO_MODELO,
  modelAudio = PADRAO_MODELO_AUDIO,
  baseUrl = PADRAO_BASE_URL,
  timeoutMs = PADRAO_TIMEOUT_MS,
  log = null,
} = {}) {
  const raiz = baseUrl.replace(/\/+$/, '');

  async function postar(caminho, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${raiz}${caminho}`, { ...init, signal: ctrl.signal });
      if (!res.ok) {
        const texto = await res.text().catch(() => '');
        throw new Error(`OpenAI HTTP ${res.status}: ${texto.slice(0, 300)}`);
      }
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function transcrever(audio) {
    const form = new FormData();
    const nomeArquivo = (audio.mimeType || '').includes('mp4') ? 'audio.mp4' : 'audio.ogg';
    form.append('file', new Blob([audio.buffer], { type: audio.mimeType || 'audio/ogg' }), nomeArquivo);
    form.append('model', modelAudio);
    form.append('language', 'pt');
    const data = await postar('/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    return data && typeof data.text === 'string' ? data.text.trim() : '';
  }

  return {
    nome: `openai:${model}`,

    async gerarJson({ systemInstruction, mensagens, anexos = [], schema, temperature = 0, maxTokens }) {
      const msgs = (mensagens || [])
        .filter((m) => m && m.content)
        .map((m) => ({ role: m.role === 'model' ? 'assistant' : m.role, content: String(m.content) }));
      if (!msgs.length) return null;
      const validos = anexos.filter((a) => a && a.buffer);
      if (validos.length) {
        const ultima = msgs[msgs.length - 1];
        const partes = [{ type: 'text', text: ultima.content }];
        for (const a of validos) {
          const tipo = a.mimeType || '';
          const dados = a.buffer.toString('base64');
          if (tipo.startsWith('audio/')) {
            const transcrito = await transcrever(a);
            if (transcrito) partes[0].text += `\n[Áudio transcrito]: ${transcrito}`;
          } else if (tipo.startsWith('image/')) {
            partes.push({ type: 'image_url', image_url: { url: `data:${tipo};base64,${dados}` } });
          } else if (tipo === 'application/pdf') {
            partes.push({ type: 'file', file: { filename: 'documento.pdf', file_data: `data:application/pdf;base64,${dados}` } });
          }
        }
        ultima.content = partes;
      }
      const corpo = {
        model,
        messages: [{ role: 'system', content: systemInstruction }, ...msgs],
        response_format: { type: 'json_schema', json_schema: { name: 'saida_estruturada', schema: paraSchemaEstrito(schema), strict: true } },
        temperature,
      };
      if (maxTokens) corpo.max_completion_tokens = maxTokens;
      const init = () => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(corpo) });
      let data;
      try {
        data = await postar('/chat/completions', init());
      } catch (err) {
        // modelos de raciocínio só aceitam a temperatura padrão
        if (!/temperature/i.test(err.message)) throw err;
        if (log) log.info({ model }, 'modelo não aceita temperature — repetindo sem o campo');
        delete corpo.temperature;
        data = await postar('/chat/completions', init());
      }
      const escolha = data && data.choices && data.choices[0];
      if (!escolha || !escolha.message || escolha.message.refusal) return null;
      try {
        return JSON.parse(String(escolha.message.content || '').trim());
      } catch {
        return null;
      }
    },
  };
}

module.exports = { createAiOpenAI, paraSchemaEstrito, PADRAO_MODELO };

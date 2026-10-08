// Quem pode vincular/desvincular o grupo de lançamentos (!financas).
// Sem esta trava, qualquer pessoa que colocasse o bot num grupo poderia "sequestrar" os
// lançamentos e perguntar ao agente quem deve quanto.
'use strict';

const soDigitos = (s) => String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '');

/**
 * @param {string} numerosCsv  NUMEROS_AUTORIZADOS do .env ("5521999998888,5511...")
 * @returns {(msg: {deMim?: boolean, remetente?: string}) => boolean}
 */
function criarVerificador(numerosCsv) {
  const autorizados = new Set(String(numerosCsv || '').split(',').map(soDigitos).filter(Boolean));
  return (msg) => {
    if (msg && msg.deMim) return true; // mensagem enviada do próprio número do bot
    const n = soDigitos(msg && msg.remetente);
    return Boolean(n) && autorizados.has(n);
  };
}

module.exports = { criarVerificador, soDigitos };

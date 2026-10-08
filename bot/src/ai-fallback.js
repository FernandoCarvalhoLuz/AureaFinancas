// Encadeia dois motores: o principal atende e, se ele CAIR (rede, timeout, 5xx depois das
// retentativas), o reserva assume. Resposta nula não troca de motor: "li e não entendi"
// não melhora em outra API, só custa em dobro.
'use strict';

function criarComFallback({ principal, reserva, log = null } = {}) {
  if (!principal) return reserva || null;
  if (!reserva) return principal;
  return {
    nome: `${principal.nome} → ${reserva.nome}`,
    principal,
    reserva,
    async gerarJson(args) {
      try {
        return await principal.gerarJson(args);
      } catch (err) {
        if (log) log.warn({ motor: principal.nome, reserva: reserva.nome, erro: err.message }, 'motor principal falhou — passando para o reserva');
        return reserva.gerarJson(args);
      }
    },
  };
}

module.exports = { criarComFallback };

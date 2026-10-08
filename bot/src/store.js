// Estado do bot em disco (DATA_DIR): o grupo de finanças vinculado com !financas.
// A sessão do WhatsApp fica em DATA_DIR/auth — é a "senha" do número: nunca versionar.
'use strict';
const fs = require('fs');
const path = require('path');

function dataDir() {
  return process.env.DATA_DIR || path.join(__dirname, '..', 'data');
}

function lerConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function gravarConfig(cfg) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(path.join(dataDir(), 'config.json'), JSON.stringify(cfg, null, 2));
}

function getFinanceGroup() {
  return lerConfig().financeGroupJid || process.env.FINANCAS_GROUP_ID || null;
}

function setFinanceGroup(jid) {
  const cfg = lerConfig();
  if (jid) cfg.financeGroupJid = jid;
  else delete cfg.financeGroupJid;
  gravarConfig(cfg);
}

module.exports = { dataDir, getFinanceGroup, setFinanceGroup };

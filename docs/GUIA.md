# Guia completo de configuração

Este guia leva você do zero até tudo funcionando: a página, as cobranças pelo WhatsApp, a leitura de faturas com IA e os lançamentos por um grupo do WhatsApp. Depois explica como usar cada parte.

**Tempo estimado:** 40 a 60 minutos na primeira vez. A maior parte é criar o servidor e as contas.

## Sumário
1. [O que você vai montar](#1-o-que-você-vai-montar)
2. [Criar o servidor](#2-criar-o-servidor)
3. [Instalar o Docker e baixar o projeto](#3-instalar-o-docker-e-baixar-o-projeto)
4. [Configurar o `.env`](#4-configurar-o-env), com todas as variáveis explicadas
5. [Subir e liberar o acesso](#5-subir-e-liberar-o-acesso)
6. [Conectar o WhatsApp](#6-conectar-o-whatsapp)
7. [HTTPS, com ou sem domínio](#7-https-recomendado)
8. [Usando cada funcionalidade](#8-usando-cada-funcionalidade)
9. [Manutenção: backup, atualização, logs](#9-manutenção)
10. [Problemas comuns](#10-problemas-comuns)
11. [Custos e privacidade](#11-custos-e-privacidade)

---

## 1. O que você vai montar

| Peça | Obrigatória? | Libera |
|---|---|---|
| Servidor com Docker | ✅ Sim | A página: meses, contas, lançamentos, divisão, painéis, importar fatura colando o texto |
| Número de WhatsApp para o bot | Opcional | Cobranças automáticas, "Cobrar todos", selo "Cobrado Nx" pelo bot |
| Chave de IA (Gemini ou OpenAI) | Opcional (precisa do bot) | Ler fatura em PDF ou foto, lançar pelo grupo do WhatsApp (texto, áudio, foto, PDF) |
| HTTPS | Recomendado (grátis, mesmo sem domínio) | Cadeado: a senha e os dados trafegam criptografados |

Dá para começar só com o servidor e ir ligando o resto depois: basta preencher o `.env` e rodar `docker compose up -d` de novo.

---

## 2. Criar o servidor

Qualquer servidor Linux com 1 GB de RAM ou mais serve: Oracle, Hetzner, DigitalOcean, AWS Lightsail, um mini PC em casa…

### Opção gratuita: Oracle Cloud Always Free
1. Crie a conta em [cloud.oracle.com](https://cloud.oracle.com). Ela pede cartão só para verificação; o plano Always Free não cobra.
2. Vá em **Compute › Instances › Create instance**:
   - **Image:** Ubuntu 24.04.
   - **Shape:** *Ampere* (ARM), `VM.Standard.A1.Flex`, com 1 OCPU e 6 GB já sobrando. Se aparecer "Out of capacity", tente outro *Availability Domain* ou mais tarde.
   - **SSH keys:** gere ou envie a sua chave pública. **Guarde a chave privada.**
3. Anote o **IP público** da instância.
4. Conecte: `ssh -i caminho/da/chave ubuntu@IP-DO-SERVIDOR`.

---

## 3. Instalar o Docker e baixar o projeto

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
exit                     # saia e conecte de novo para o grupo valer
```
```bash
git clone https://github.com/FernandoCarvalhoLuz/AureaFinancas.git aurea
cd aurea
cp .env.example .env
```

---

## 4. Configurar o `.env`

Abra o arquivo com `nano .env`. Para salvar, use Ctrl+O e Enter; para sair, Ctrl+X. Cada variável está explicada abaixo.

### 4.1 Acesso (obrigatório)

| Variável | Exemplo | O que é |
|---|---|---|
| `APP_SENHA` | `uma-frase-longa-que-so-voce-sabe` | Senha para entrar na página. Mínimo de 8 caracteres; quanto mais longa, melhor. Depois de 8 erros, o login trava por 15 minutos. Se você trocar a senha, todos os aparelhos logados saem. |
| `CHAVE_INTERNA` | (gerada) | Segredo entre a página e o bot. Gere com `openssl rand -hex 24` e cole o resultado. Você nunca vai digitá-la em lugar nenhum. |
| `SESSAO_DIAS` | `30` | *(opcional)* Por quantos dias o navegador fica logado. |

### 4.2 Quem é você

| Variável | Exemplo | O que é |
|---|---|---|
| `NOMES_EU` | `Ana,Eu` | Os nomes que contam como **"minha parte"**. Os lançamentos de qualquer outra pessoa entram em **"A receber"**. O primeiro nome é o que o bot usa quando você escreve "eu paguei". |
| `ANO_BASE` | `2026` | O ano dos meses gravados sem ano: "Agosto" quer dizer Agosto de 2026. A partir de janeiro do ano seguinte, os meses passam a ter o ano no nome ("Janeiro 2027"). **Defina uma vez, antes de começar, e não mude depois.** |

> **Exemplo:** com `NOMES_EU=Ana,Eu`, um aluguel de R$ 1.500 dividido entre Ana e Bruno fica com R$ 750 em "minha parte". Os R$ 750 do Bruno aparecem em "A receber", com botão para cobrar.

### 4.3 Inteligência artificial (opcional)

A IA lê faturas em PDF ou foto e conversa no grupo do WhatsApp. **Ela só funciona com o bot ativo.** Basta uma das chaves; se você colocar as duas, a segunda vira reserva e entra sozinha se a primeira cair.

**Gemini (recomendado: rápido e barato)**
1. Acesse [aistudio.google.com/apikey](https://aistudio.google.com/apikey) com uma conta Google.
2. Clique em **Create API key** e copie a chave.
3. **Privacidade:** no nível gratuito, o Google pode usar o conteúdo enviado para melhorar os produtos dele, incluindo as suas faturas. Para que isso não aconteça, **ative o faturamento** (Billing) no projeto da chave; o custo do uso doméstico fica em centavos. Veja os [termos da API](https://ai.google.dev/gemini-api/terms).

**OpenAI (alternativa ou reserva)**
1. Acesse [platform.openai.com/api-keys](https://platform.openai.com/api-keys), crie a chave e adicione créditos em *Billing*.

| Variável | Padrão | O que é |
|---|---|---|
| `GEMINI_API_KEY` | (vazio) | Chave do Gemini. |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | Modelo. O padrão é o mais barato que dá conta bem. |
| `OPENAI_API_KEY` | (vazio) | Chave da OpenAI. |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Modelo. |
| `IA_MOTOR` | `gemini` | Qual é o principal: `gemini` ou `openai`. |

### 4.4 WhatsApp (opcional)

| Variável | Exemplo | O que é |
|---|---|---|
| `NUMEROS_AUTORIZADOS` | `5521999998888` | O **seu** WhatsApp pessoal (55 + DDD + número). Só ele (e o próprio número do bot) pode vincular o grupo de lançamentos. Para vários números, separe com vírgula. |
| `URL_PUBLICA` | `https://financas.seudominio.com.br` | Link da página, que o bot manda depois de cada lançamento. Opcional. |

### 4.5 Rede

| Variável | Padrão | O que é |
|---|---|---|
| `PORTA` | `8080` | Porta da página no servidor. |
| `APP_BIND` | `0.0.0.0` | Em qual interface a porta abre. Com HTTPS, use `127.0.0.1`. |
| `DOMINIO` | (vazio) | Endereço para o HTTPS (seção 7): o seu domínio ou um `sslip.io` grátis. |
| `PROXY_CONFIAVEL` | `0` | Com HTTPS pelo Caddy, use `1`. |
| `LOG_LEVEL` | `info` | Quanto detalhe o bot escreve no log: `info`, `warn` ou `debug`. |

---

## 5. Subir e liberar o acesso

```bash
docker compose up -d --build
docker compose ps
```
Espere alguns segundos até `app` e `bot` aparecerem como **healthy**. Se o app reiniciar sem parar, rode `docker compose logs app`; geralmente é o `.env` incompleto.

**Libere a porta 8080:**
- **No painel da Oracle:** Networking › Virtual Cloud Networks › (sua VCN) › Security Lists › Default › **Add Ingress Rule**, com Source `0.0.0.0/0`, protocolo TCP e porta de destino `8080`.
- **No servidor** (a Ubuntu da Oracle vem com firewall interno):
  ```bash
  sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT
  sudo netfilter-persistent save
  ```

Abra `http://IP-DO-SERVIDOR:8080` e entre com a `APP_SENHA`. Pronto: a página já funciona.

---

## 6. Conectar o WhatsApp

### Escolha o número do bot
O bot usa o WhatsApp de um número **como um "aparelho conectado"**, do mesmo jeito que o WhatsApp Web. As mensagens de cobrança saem desse número.

- **Recomendado:** um chip só para isso, com o app WhatsApp ou WhatsApp Business num celular qualquer. Basta ligar o celular de vez em quando; ele não precisa ficar sempre online.
- **Funciona, mas evite:** o seu número pessoal. As cobranças sairiam no seu nome, e o bot veria os seus grupos (ele só age no grupo vinculado, mas é melhor separar).

> O bot usa o [Baileys](https://github.com/WhiskeySockets/Baileys), um cliente **não oficial**. Para uso pessoal e moderado, com poucas cobranças por dia, tudo bem. Disparos em massa podem levar o WhatsApp a bloquear o número. O bot já espera 3 segundos entre uma mensagem e outra.

### Parear
1. Na página, clique na **engrenagem** (Configurações). Aparece um **QR Code**.
2. No celular do número do bot: **WhatsApp › Aparelhos conectados › Conectar um aparelho**, e aponte para o QR.
3. A tela muda para **"WhatsApp conectado"**. A sessão fica salva no volume do Docker e sobrevive a reinícios e atualizações.

### Vincular o grupo de lançamentos (precisa de IA)
1. No **seu** WhatsApp, crie um grupo (ex.: "Lançamentos") e adicione o número do bot.
2. Mande no grupo: **`!financas`**. A mensagem precisa sair de um número que esteja em `NUMEROS_AUTORIZADOS`.
3. O bot responde "✅ Grupo de finanças vinculado!".
4. Para desvincular, mande `!financas sair`.

Se o bot responder "⛔ Só o dono desta instalação pode vincular um grupo", veja o log com `docker compose logs bot | grep remetente`. Copie o número que aparece para `NUMEROS_AUTORIZADOS` e rode `docker compose up -d`.

### Áudio de cobrança (opcional)
Você pode gravar uma mensagem de voz para ir junto com cada cobrança. Veja [`bot/media/LEIA-ME.md`](../bot/media/LEIA-ME.md) e depois ligue **"Enviar áudio junto"** em Configurações.

---

## 7. HTTPS (recomendado)

Sem HTTPS, a senha e os dados viajam sem criptografia entre o navegador e o servidor; num Wi-Fi público, alguém poderia capturar a senha. O Caddy (já incluído) emite e renova o certificado sozinho, de graça (Let's Encrypt). Você só precisa de um endereço que aponte para o servidor.

### Escolha o endereço
- **Sem domínio (grátis, na hora):** use o [sslip.io](https://sslip.io), que transforma o IP em nome. Troque os pontos do IP por traços: o servidor `203.0.113.10` vira **`financas.203-0-113-10.sslip.io`**. Não precisa configurar nada além disso.
- **Com domínio próprio:** no painel do domínio, crie um registro **DNS tipo A** (ex.: `financas`) apontando para o IP do servidor. O endereço fica `financas.seudominio.com.br`.

### Ligue o HTTPS
1. No `.env` (troque pelo seu endereço):
   ```
   DOMINIO=financas.203-0-113-10.sslip.io
   APP_BIND=127.0.0.1
   PROXY_CONFIAVEL=1
   URL_PUBLICA=https://financas.203-0-113-10.sslip.io
   COMPOSE_PROFILES=https
   ```
   - `APP_BIND=127.0.0.1` tira a porta 8080 da internet: só o Caddy fala com a página.
   - `PROXY_CONFIAVEL=1` faz o app confiar no Caddy para saber o IP real (trava de senha) e que a conexão é HTTPS. Com isso, o cookie de sessão sai marcado como `Secure` e o navegador passa a recusar a versão sem cadeado (HSTS). Use só junto com `APP_BIND=127.0.0.1`.
   - `COMPOSE_PROFILES=https` liga o Caddy em todo `docker compose up`, sem precisar lembrar de nada.
2. Libere as portas **80 e 443** (no painel da nuvem e no iptables, como na seção 5) e tire a regra da 8080:
   ```bash
   sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
   sudo iptables -D INPUT -p tcp --dport 8080 -j ACCEPT
   sudo netfilter-persistent save
   ```
3. Suba de novo:
   ```bash
   docker compose up -d --build
   docker compose ps          # agora aparece também o "caddy"
   ```
4. Acesse `https://` + o seu endereço. O primeiro acesso pode levar uns 30 segundos enquanto o certificado é emitido.

**Alternativa sem expor nada:** instale o [Tailscale](https://tailscale.com) no servidor e nos seus aparelhos. A página fica acessível só para você, e nenhuma porta precisa ficar aberta para a internet.

---

## 8. Usando cada funcionalidade

### Meses
- **Novo mês** (botão dourado): cria o mês seguinte ao mais recente, e você pode avançar com as setas. Antes de confirmar, ele mostra o que vai acontecer:
  - **leva as contas** que você marcar;
  - **avança as parcelas** (3/10 vira 4/10) e deixa de fora as que terminaram;
  - **repete os valores sem parcela** (aluguel, luz), se a opção estiver ligada, como pendentes para você só ajustar.
- **Lista de meses** na lateral: cada mês mostra o total e uma barra de quanto já foi pago. Clique para trocar de mês.
- Aluguel, Conta de Luz e Conta de Internet são criados automaticamente em todo mês.

### Contas (cartões, serviços, despesas)
- **"+ Nova conta"** no fim da lista. A conta vale só para o mês aberto; o "Novo mês" leva para os seguintes.
- **Logos automáticos** quando o nome contém: Santander, Itaú, Inter, Mercado Livre, Mercado Pago, Premiere, Nubank, PicPay, Carrefour, YouTube, Netflix, Spotify, iFood, Uber, Vivo, Neon, PagBank/PagSeguro, Shopee, AliExpress, HBO Max.
- Clique numa conta para abrir a gaveta com os lançamentos, agrupados por pessoa. A lixeira no topo exclui a conta (e dá para desfazer).

### Lançamentos
Dentro de uma conta, use **"Novo lançamento"**:
- **Quem paga:** digite o nome e tecle Enter. **Com várias pessoas, o valor é dividido** em centavos, e a sobra fica com a primeira. Os nomes já usados aparecem como sugestão.
- **Valor:** aceita `1.234,56` ou `1234.56`.
- **Parcelas:** "parcela atual" e "total" (ex.: 1 e 10). Deixe em branco se for à vista.
- **Já está pago:** marque se o valor já foi acertado.
- **Ações na lista:** o ✓ à esquerda alterna pago/pendente (com confete 🎉). O lápis edita e a lixeira remove.
- **Desfazer:** depois de remover ou excluir algo, aparece o botão **Desfazer** por alguns segundos.

### Painel
- **Total do mês:** compara com o mês anterior e separa "minha parte" de "terceiros".
- **A receber, Quitado, Parcelamentos:** quanto falta receber, quanto do mês já foi pago e quantas parcelas estão em andamento, incluindo quando acaba a última.
- **Evolução:** os últimos 6 meses. Clique numa barra para ir ao mês.
- **Parcelas já contratadas:** quanto dos próximos meses já está comprometido.
- **Reta final:** os parcelamentos que estão acabando.
- **Busca e filtros:** a tecla `/` leva para a busca. Os botões filtram Todas, Pendentes ou Parceladas.

### A receber e cobranças (precisa do bot para cobrar automaticamente)
- **Mês × Tudo em aberto:** mostra o que cada pessoa deve no mês aberto, ou em todos os meses.
- **Telefone:** clique na pessoa e preencha o WhatsApp (55 + DDD + número). Ele fica salvo **neste navegador**.
- **Cobrar uma pessoa:** abre a prévia da mensagem, no estilo de um balão do WhatsApp, com três saídas:
  - **Enviar pelo bot:** sai do número do bot;
  - **WhatsApp Web:** abre a conversa no seu WhatsApp, com a mensagem pronta;
  - **Copiar:** copia o texto.
- **Cobrar todos:** manda uma mensagem por pessoa, uma de cada vez, e mostra o andamento.
- **"📣 Cobrado 2x · hoje às 14:30":** o selo conta as cobranças feitas sobre o que a pessoa **ainda deve**. A partir de 3 cobranças, ele fica laranja.
- **Tudo pago:** marca todas as pendências da pessoa de uma vez.

### Importar fatura
Abra uma conta e clique em **"Importar fatura"**:
1. **Envie o PDF ou a foto** (PDF, JPG, PNG ou WEBP, até 12 MB) **ou cole o texto** da fatura ou de uma lista de cobranças.
   - Com IA, a leitura entende parcelas ("02/05"), estornos e ignora pagamento e total.
   - Sem IA, só o texto colado é lido, numa leitura simples: cada linha com valor vira um item.
2. **Revise e distribua:**
   - quem paga cada linha vem **sugerido pelo histórico** (quem pagou algo parecido antes), ou você;
   - linhas iguais a lançamentos que já estão na conta aparecem como **"já lançado"** e ficam de fora, para não duplicar parcelas;
   - **estornos** ficam de fora até você incluir; se incluir, entram negativos;
   - **selecione linhas e toque nos nomes** para pôr ou tirar pessoas. Com várias pessoas, a linha é dividida;
   - o rodapé mostra **quanto cada pessoa vai pagar** e se o distribuído **bate com o total da fatura**.
3. **Lançar:** grava tudo de uma vez (com Desfazer).

### Lançar pelo WhatsApp (precisa do bot, da IA e do grupo vinculado)
No grupo, mande do jeito que falaria:
- `uber 32,50 no nubank, eu`
- `tênis de 300 em 3x no mercado livre, divide com a Ana`
- *(áudio)* "paguei a luz, 230 reais, metade é do Bruno"
- *(foto do comprovante ou PDF da fatura)* + "isso é do cartão Inter"
- `lança em novembro: netflix 55,90 no nubank, à vista`

O agente **pergunta o que faltar**: o mês, a conta, quem paga, o valor, e se é à vista ou parcelado. Quando tiver tudo, ele mostra um **resumo exato** do que vai gravar:
```
📝 Confere o lançamento:
MERCADO LIVRE · Outubro
   tênis — R$ 100,00 (parcela 1/3) — compra de R$ 300,00
   👥 Ana R$ 50,00 · Bruno R$ 50,00
Responda OK para lançar, ou me diga o que mudar.
```
- **Confirmar:** `ok`, `sim`, `confirmo`, `pode lançar`, `isso`, 👍 ou ✅. **Só depois disso algo é gravado.**
- **Corrigir:** mande a correção, por exemplo "na verdade foi em 4x". Ele refaz o resumo.
- **Desistir:** `cancela`, `esquece` ou `desisto`. O rascunho também expira sozinho em 30 minutos.
- **Mês que ainda não existe:** se o mês vier depois do mais recente (até 3 meses à frente), ele avisa que vai **criar o mês** do mesmo jeito que o "Novo mês" da página.
- **Perguntas:** "quanto a Ana está devendo?" funciona, com base nas pendências do mês mais recente.
- A página aberta mostra os lançamentos novos em até 12 segundos, sem recarregar.

### Preferências
- **Tema claro/escuro:** o botão ◐ na lateral.
- **Reduzir animações:** em Configurações. A página também respeita a configuração de acessibilidade do sistema.
- **Sair:** em Configurações. Encerra a sessão neste navegador.

---

## 9. Manutenção

**Ver se está tudo rodando**
```bash
docker compose ps
docker compose logs -f bot      # Ctrl+C para sair
docker compose logs -f app
```

**Backup:** os dados ficam em volumes do Docker.
```bash
docker compose cp app:/data ./backup-$(date +%F)     # gera a pasta com o financas.db
```
Copie a pasta para fora do servidor. Do seu computador, por exemplo: `scp -r ubuntu@IP:~/aurea/backup-AAAA-MM-DD .`.

Para fazer **backup automático todo dia às 3h**, rode `crontab -e` e acrescente:
```
0 3 * * * cd ~/aurea && mkdir -p backups && docker compose cp app:/data ./backups/$(date +\%F) >/dev/null 2>&1
```

**Restaurar**
```bash
docker compose stop app
docker compose cp ./backup-AAAA-MM-DD/financas.db app:/data/financas.db
docker compose start app
```

**Atualizar para a versão mais nova**
```bash
cd ~/aurea && git pull && docker compose up -d --build
```
Os dados e a sessão do WhatsApp continuam.

**Trocar a senha:** edite `APP_SENHA` e rode `docker compose up -d`. Todos os aparelhos saem.

**Desconectar o WhatsApp:** no celular do bot, em Aparelhos conectados, encerre a sessão. Na próxima vez, a página mostra um QR novo.

---

## 10. Problemas comuns

| Sintoma | Causa provável e solução |
|---|---|
| A página não abre | A porta está fechada no painel da nuvem ou no iptables (seção 5), ou o app não subiu: veja `docker compose ps` e `docker compose logs app`. |
| "Configuração inválida" no log do app | `APP_SENHA` com menos de 8 caracteres ou `CHAVE_INTERNA` com menos de 24. Gere a chave com `openssl rand -hex 24`. |
| "Muitas tentativas" no login | 8 senhas erradas. Espere 15 minutos. |
| Configurações diz "Bot fora do ar" | Veja `docker compose logs bot`. Erro de `CHAVE_INTERNA` faz o bot encerrar. |
| O QR não aparece | Espere uns 10 segundos e reabra Configurações. O QR também sai no log do bot. |
| O WhatsApp desconecta sempre | O celular do bot ficou sem internet por muitos dias, ou a sessão foi encerrada nele. Pareie de novo. |
| A cobrança falha com "número não tem WhatsApp" | Confira o telefone da pessoa (55 + DDD + número). |
| A cobrança com áudio falha | Falta o `bot/media/cobranca.ogg`, ou ele foi colocado depois do build: rode `docker compose up -d --build`. |
| "Importar fatura" só aceita texto | Falta o bot ou a chave de IA (seção 4.3). |
| A leitura da fatura falha | Chave de IA inválida ou sem crédito: veja `docker compose logs bot`. Fotos tortas ou escuras atrapalham; prefira o PDF. |
| `!financas` recusado | Seu número não está em `NUMEROS_AUTORIZADOS` (seção 6). |
| O bot não responde no grupo | O grupo não está vinculado (mande `!financas`), falta a chave de IA, ou o bot não está no grupo. |
| "Recarreguei a versão atual" ao salvar | Um lançamento chegou pelo WhatsApp enquanto você editava. A página recarregou para não apagá-lo; refaça a última alteração. |
| Os telefones sumiram | Eles ficam salvos no navegador. Em outro aparelho ou navegador, é preciso cadastrar de novo. |

---

## 11. Custos e privacidade

**Custos**
- **Servidor:** grátis na Oracle Always Free, ou cerca de US$ 4 a 6/mês numa VPS paga.
- **IA:** frações de centavo por fatura ou mensagem com o Gemini Flash-Lite. No uso doméstico, alguns centavos por mês.
- **WhatsApp e domínio:** o WhatsApp é grátis. O domínio, se você quiser, custa a partir de uns R$ 40/ano (`.com.br`).

**Onde ficam os dados**
- **Os seus dados** ficam só no seu servidor, nos volumes do Docker. Nada vai para o repositório nem para o autor do projeto.
- **A IA** recebe apenas o que você pediu para ler: a fatura ou a mensagem do grupo, junto com os nomes das contas e das pessoas, para entender o pedido. Leia a observação sobre o nível gratuito do Gemini na seção 4.3.
- **Os telefones das pessoas cobradas** ficam no navegador onde você os cadastrou.

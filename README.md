# Áurea · Finanças da casa

Controle das contas da casa e dos cartões, com a divisão entre as pessoas: quem pagou, quem deve, quanto falta e quais parcelas ainda vêm. Tem cobrança e lançamento pelo WhatsApp.

- **Meses e contas.** Cada mês tem as suas contas (aluguel, luz, cartões, assinaturas). O "Novo mês" copia as contas do mês anterior, avança as parcelas e repete os valores fixos.
- **Divisão entre pessoas.** Cada lançamento tem quem paga. Se forem várias pessoas, o valor é dividido em centavos, sem sobra.
- **A receber.** Mostra quem deve quanto, com um selo "Cobrado 2x" para quem já foi cobrado.
- **Cobrança pelo WhatsApp.** Uma mensagem por pessoa com tudo o que ela deve, ou "Cobrar todos" de uma vez.
- **Importar fatura.** Você manda o PDF, uma foto ou o texto da fatura. A IA lê as linhas e você distribui entre as pessoas antes de lançar.
- **Lançar pelo WhatsApp.** Num grupo, você manda texto, áudio, foto ou PDF. O agente pergunta mês, conta, quem paga e parcelas, e **só lança depois do seu OK**.
- **Projeções.** Mostra a evolução mês a mês, as parcelas já contratadas e as que estão perto de acabar.

---

## Como funciona

```
 navegador ──(senha)──► app :8080 ──(rede interna)──► bot ──► WhatsApp
                          │                            │
                       SQLite                     IA (Gemini/OpenAI)
                    (volume "app")             sessão do WhatsApp (volume "bot")
```

- **`app`** serve a página e guarda os dados (SQLite). Só ele fica exposto, e tudo depende da senha da instalação.
- **`bot`** cuida do WhatsApp e da IA. Ele não tem porta pública: só o `app` fala com ele, usando a `CHAVE_INTERNA`.
- **Seus dados** ficam no seu servidor, e só nele. A IA só recebe a mensagem ou a fatura que você mandou ler.

---

## O que você precisa

| Item | Para quê | Observação |
|---|---|---|
| Um servidor Linux com Docker | Rodar tudo 24h | A VPS gratuita da Oracle Cloud (Always Free, ARM) sobra. Qualquer VPS com 1 GB de RAM serve. |
| Um número de WhatsApp para o bot | Mandar cobranças e conversar no grupo | Prefira um chip só para isso: o bot fica conectado como "aparelho conectado" desse número. |
| Uma chave do Gemini (opcional) | Ler faturas e entender os lançamentos pelo WhatsApp | [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Custa centavos por mês no uso doméstico. Sem ela, só as cobranças funcionam. |
| Um domínio (opcional, recomendado) | HTTPS (cadeado) | Sem HTTPS, a senha trafega sem criptografia. Veja [HTTPS](#https-recomendado). |

---

## Instalação (Ubuntu)

### 1. Docker
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # depois saia e entre de novo no SSH
```

### 2. Baixar o projeto
```bash
git clone <URL-DO-REPOSITORIO> aurea
cd aurea
```
O repositório é privado. O GitLab vai pedir o seu usuário e um **token de acesso** (GitLab › Preferências › Tokens de acesso, permissão `read_repository`) no lugar da senha.

### 3. Configurar
```bash
cp .env.example .env
openssl rand -hex 24      # copie o resultado para CHAVE_INTERNA
nano .env
```
Preencha pelo menos:
- `APP_SENHA`: a senha para entrar na página.
- `CHAVE_INTERNA`: o valor gerado acima.
- `NOMES_EU`: o seu nome, como você vai lançar (ex.: `Ana,Eu`). Esses nomes contam como "minha parte".
- `GEMINI_API_KEY`: se quiser a IA.
- `NUMEROS_AUTORIZADOS`: o seu WhatsApp pessoal com 55 e DDD (ex.: `5521999998888`).

### 4. Subir
```bash
docker compose up -d --build
docker compose ps          # app e bot devem aparecer "running"/"healthy"
```

### 5. Abrir a porta
- **No painel da nuvem** (na Oracle: VCN › Security List › Ingress Rule, TCP 8080), libere a porta 8080 (ou 80/443, se for usar HTTPS).
- **No próprio servidor**, se a imagem vier com firewall (a Ubuntu da Oracle vem):
  ```bash
  sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT
  sudo netfilter-persistent save
  ```

### 6. Usar
1. Abra `http://IP-DO-SERVIDOR:8080` e entre com a `APP_SENHA`.
2. **Conectar o WhatsApp:** clique na engrenagem (Configurações). No celular do número do bot, vá em WhatsApp › Aparelhos conectados › Conectar um aparelho e leia o QR Code.
3. **Primeiro mês:** clique em "Novo mês". Depois adicione as contas e os lançamentos.
4. **Lançar pelo WhatsApp:** crie um grupo com o número do bot e mande `!financas` **do seu número** (o que está em `NUMEROS_AUTORIZADOS`). Depois é só mandar os gastos ali. Para desvincular, mande `!financas sair`.

---

## HTTPS (recomendado)

Com um domínio apontando para o servidor (registro DNS tipo **A** com o IP), o Caddy cria e renova o certificado sozinho.

1. No `.env`:
   ```
   DOMINIO=financas.seudominio.com.br
   APP_BIND=127.0.0.1
   PROXY_CONFIAVEL=1
   ```
2. Libere as portas **80 e 443** (painel da nuvem + iptables, como no passo 5) e feche a 8080.
3. Suba com o perfil https:
   ```bash
   docker compose --profile https up -d --build
   ```
4. Acesse `https://financas.seudominio.com.br`.

Sem domínio, uma alternativa segura é o [Tailscale](https://tailscale.com): o servidor só fica acessível a partir dos seus aparelhos.

---

## Backup

Os dados ficam em volumes do Docker. Para copiar:
```bash
docker compose cp app:/data ./backup-$(date +%F)
```
A pasta gerada tem o `financas.db`. Guarde fora do servidor (no Google Drive, por exemplo).

Para restaurar:
```bash
docker compose stop app
docker compose cp ./backup-AAAA-MM-DD/financas.db app:/data/financas.db
docker compose start app
```

Para fazer backup automático todo dia às 3h, rode `crontab -e` e acrescente:
```
0 3 * * * cd ~/aurea && docker compose cp app:/data ./backups/$(date +\%F) >/dev/null 2>&1
```

---

## Atualizar
```bash
cd ~/aurea
git pull
docker compose up -d --build
```
Os dados e a sessão do WhatsApp continuam nos volumes.

---

## Segurança

- **O repositório é privado.** Nunca suba o `.env`: ele está no `.gitignore`.
- **Use uma senha forte**, com 8 caracteres ou mais. Depois de 8 erros, o login fica bloqueado por 15 minutos.
- **O banco não é servido pela web.** Só a pasta `app/public` é pública.
- **O bot não tem porta aberta.** Só o `app` fala com ele, usando a `CHAVE_INTERNA`.
- **Só números autorizados vinculam o grupo de lançamentos.** Assim, ninguém que coloque o bot num grupo consegue ver ou lançar nas suas contas.
- **Os telefones das pessoas cobradas ficam salvos no navegador** onde você os cadastrou.
- **Para trocar a senha**, mude `APP_SENHA` no `.env` e rode `docker compose up -d`. Todas as sessões abertas caem, e cada aparelho precisa entrar de novo.

---

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| A página não abre | Rode `docker compose ps` e `docker compose logs app`, e confira a porta no painel da nuvem e no iptables. |
| "Configuração inválida" no log do app | Falta `APP_SENHA` (mínimo 8) ou a `CHAVE_INTERNA` tem menos de 24 caracteres. |
| O QR não aparece em Configurações | Veja `docker compose logs -f bot`. O QR também é impresso no log. |
| `!financas` recusado | O log do bot mostra o `remetente`. Coloque esse número em `NUMEROS_AUTORIZADOS` e rode `docker compose up -d`. |
| O WhatsApp desconectou | Abra Configurações e leia o QR de novo. |
| A leitura de fatura falha | Confira a `GEMINI_API_KEY` e veja `docker compose logs bot`. |
| Esqueci a senha | Troque `APP_SENHA` no `.env` e rode `docker compose up -d`. |
| Perdi um aparelho logado | Troque `APP_SENHA` e rode `docker compose up -d`: todas as sessões caem. |

---

## Custos

- **Servidor:** grátis na Oracle Always Free, ou a partir de uns US$ 5/mês em outra VPS.
- **IA (Gemini Flash-Lite):** cada fatura lida ou mensagem do agente custa frações de centavo. No uso doméstico, fica na casa de centavos por mês.
- **WhatsApp:** grátis (usa o WhatsApp normal do número do bot).

---

## Desenvolvimento (sem Docker)

Requer Node 20 ou mais novo.
```bash
cd app && npm install && npm test
cd ../bot && npm install && npm test
# rodar: (na raiz, com o .env preenchido)
node --env-file=.env app/server.js                                  # página em :8080
BOT_URL=http://127.0.0.1:8081 node --env-file=.env app/server.js    # página falando com o bot
FINANCAS_URL=http://127.0.0.1:8080 node --env-file=.env bot/server.js
```

## Créditos

- **Logos dos bancos e serviços:** [Simple Icons](https://simpleicons.org) (CC0) e Wikimedia Commons (domínio público). São marcas registradas dos seus donos e aparecem aqui só para identificar as contas.
- **Ícones:** [Bootstrap Icons](https://icons.getbootstrap.com) (MIT).
- **Fontes:** Bricolage Grotesque, Geist e Geist Mono (Google Fonts, OFL).
- **WhatsApp:** [Baileys](https://github.com/WhiskeySockets/Baileys). É um cliente não oficial: use com moderação, para não arriscar o número.

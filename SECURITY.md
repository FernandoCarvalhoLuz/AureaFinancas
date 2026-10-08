# Segurança

O Áurea guarda dados financeiros da sua casa. Esta página explica o que o protege e o que você precisa fazer na instalação.

## Checklist da instalação

- [ ] **`APP_SENHA` longa e só sua.** Uma frase com 4 ou mais palavras vale mais que uma senha curta com símbolos.
- [ ] **`CHAVE_INTERNA` gerada** com `openssl rand -hex 24`. Nunca reaproveite exemplos.
- [ ] **HTTPS ligado** ([guia, seção 7](docs/GUIA.md#7-https-recomendado)). É grátis, mesmo sem domínio (sslip.io): `DOMINIO`, `APP_BIND=127.0.0.1`, `PROXY_CONFIAVEL=1` e `COMPOSE_PROFILES=https`.
- [ ] **Firewall só com as portas necessárias:** 22 (SSH), 80 e 443. Com HTTPS, a 8080 não precisa ficar aberta.
- [ ] **`NUMEROS_AUTORIZADOS`** com o seu WhatsApp, se o bot usar um número diferente do seu.
- [ ] **O `.env` nunca vai para o Git**, nem em fork. Ele já está no `.gitignore`.
- [ ] **Backup do banco fora do servidor** ([README › Backup](README.md#backup)).

## Como a instalação se protege

| Camada | O que faz |
|---|---|
| **Login** | Senha (`APP_SENHA`) → cookie de sessão `HttpOnly`, `SameSite=Strict` e, com HTTPS, `Secure`. As sessões ficam no banco como hash SHA-256. Depois de 8 senhas erradas, o IP fica bloqueado por 15 minutos. Trocar a senha derruba todas as sessões. |
| **Arquivos servidos** | Só a pasta `app/public`. O banco fica no volume `DATA_DIR`, fora do alcance do navegador. |
| **API** | Tudo em `/api` exige a sessão ou a `CHAVE_INTERNA`, comparada em tempo constante. |
| **Bot do WhatsApp** | Sem porta publicada: só o `app` fala com ele, pela rede interna do Docker, com a `CHAVE_INTERNA`. O QR de pareamento só aparece para quem está logado. |
| **Grupo de lançamentos** | Só o próprio número do bot e os `NUMEROS_AUTORIZADOS` vinculam o grupo com `!financas`. O agente só grava depois de um "OK" explícito. |
| **Navegador** | Envia Content-Security-Policy sem scripts inline, `X-Frame-Options: DENY`, `nosniff` e, com HTTPS, HSTS. Os arquivos de CDN são verificados com SRI (`integrity`). |
| **Contêineres** | Rodam como usuário sem privilégios (`node`), com os dados em volumes nomeados. |

## Limites conhecidos

- **Um usuário por instalação:** uma senha só, sem contas separadas. Quem tem a senha vê tudo.
- **WhatsApp não oficial:** o bot usa o [Baileys](https://github.com/WhiskeySockets/Baileys). A sessão salva no volume `bot` equivale a um aparelho conectado ao número. Proteja o acesso ao servidor (SSH só com chave).
- **IA de terceiros:** o texto, o áudio ou a fatura que você manda ler vão para o Gemini ou a OpenAI. No nível gratuito do Gemini, o Google pode usar esse conteúdo (veja o [guia, seção 4.3](docs/GUIA.md#43-inteligência-artificial-opcional)).
- **Telefones das pessoas cobradas:** ficam no navegador onde foram cadastrados (IndexedDB), não no servidor.

## Encontrou uma falha?

Não abra uma issue pública. Use **Security › Report a vulnerability** neste repositório no GitHub (relato privado). Descreva como reproduzir e o impacto.

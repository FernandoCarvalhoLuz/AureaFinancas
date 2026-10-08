# Áudio de cobrança (opcional)

Se quiser que o bot mande uma mensagem de voz depois do texto da cobrança, grave um áudio
e salve aqui como `cobranca.ogg` (formato OGG/Opus, como as mensagens de voz do WhatsApp).
Depois ligue "Enviar áudio junto" em Configurações, na página.

Para converter um MP3/M4A: `ffmpeg -i meu-audio.m4a -c:a libopus -b:a 32k -ac 1 cobranca.ogg`

O arquivo não vai para o git (cada instalação grava o seu) e precisa ser copiado para a
imagem: rode `docker compose up -d --build` depois de colocá-lo aqui.

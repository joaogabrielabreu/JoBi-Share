# Janela: compartilhamento de tela P2P

Compartilhe a tela do PC em tempo real com qualquer pessoa, no celular ou no PC.
Basta ter um navegador, sem instalar nada do lado de quem assiste.

- **Qualidade ajustável ao vivo:** 720p / 1080p / 1440p / Nativa × 15 / 30 / 60 fps,
  modo *Movimento* (jogos e vídeos) ou *Nitidez* (texto e código), e codec
  (AV1 / VP9 / H.264 / VP8).
- **Direto entre os dispositivos (P2P):** o vídeo não passa pelo servidor.
- **Integridade garantida:** criptografia de ponta a ponta, autenticação de
  cada pacote e verificação por código contra interceptação (detalhes abaixo).
- Áudio do sistema, troca de tela sem desconectar, pausa, vários espectadores
  (até 8), QR code para o celular, tela cheia e picture-in-picture.

## Como usar

1. Dê dois cliques em **`Iniciar.bat`**. Na primeira vez, ele cria o ambiente
   Python e baixa as dependências (e o `cloudflared`, usado no link de internet).
2. O navegador abre em `http://localhost:8420`. Clique em **Começar a transmitir**,
   ajuste a qualidade e clique em **Escolher tela**.
3. Envie o **link** (aba *Internet* para quem está longe, *Mesma rede* para quem
   está no mesmo Wi-Fi) ou o **código** (ex.: `K7M-2QX`). No celular, dá para
   usar o **QR code**.
4. Aceite o pedido de entrada. Os dois lados veem um **código de segurança de
   6 dígitos**. Confirmem por ligação ou mensagem que é o mesmo número e cliquem
   em **Confere**. A tela só é liberada depois disso (dá para desativar).

`Iniciar (somente rede local).bat` não cria link público: só aparelhos na mesma
rede conseguem entrar.

Requisitos: Python 3.10+ no PC que transmite. Para transmitir, use Chrome, Edge
ou Firefox no computador. Para assistir, qualquer navegador moderno serve
(Chrome, Safari, Firefox, Edge, inclusive no celular).

## Como a integridade é garantida

| Camada | O que garante |
|---|---|
| **DTLS-SRTP** (WebRTC) | Vídeo, áudio e controle cifrados (AES) de ponta a ponta. O servidor só faz a apresentação e nunca vê o conteúdo. |
| **Autenticação por pacote** (HMAC-SHA1 / AES-GCM) | Um pacote alterado no caminho é descartado. O que é exibido é exatamente o que foi enviado. Perdas de rede são repostas por retransmissão (NACK) e aparecem nas estatísticas. |
| **Compromisso + código de verificação (SAS)** | O anfitrião gera uma chave DTLS nova para cada espectador e envia o *hash* dela antes de ver a chave do espectador. O espectador confere esse compromisso quando a resposta chega, e os dois calculam um código de 6 dígitos a partir das duas chaves realmente usadas. Um intermediário, mesmo o próprio servidor, teria códigos diferentes nos dois lados, e o compromisso impede que ele "fabrique" um código igual (1 chance em 1.000.000 por tentativa). |
| **Liberação só após verificar** | Com a opção ativada (padrão), nenhuma imagem sai do PC antes de o anfitrião confirmar o código. As confirmações viajam pelo canal de dados cifrado, então não podem ser forjadas pelo servidor. |
| **Validação do SDP** | Descrições de sessão com impressões digitais divergentes ou fora do padrão são rejeitadas, e a chave não pode mudar no meio da sessão. |

No espectador, o botão de estatísticas mostra a versão do DTLS, a cifra SRTP,
os pacotes recebidos e perdidos, as retransmissões, os congelamentos e a
impressão digital da chave do anfitrião.

## Rede e conectividade

- O link de internet usa um **Cloudflare Quick Tunnel** (gratuito, sem conta, HTTPS).
  Ele só transporta a página e a sinalização. O vídeo segue P2P.
- A conexão P2P usa STUN (Google/Cloudflare) e funciona na grande maioria das
  redes. Em redes muito restritivas (NAT simétrico dos dois lados, redes
  corporativas), pode ser preciso um servidor **TURN**. Crie um `config.json`
  ao lado do `server.py`:

  ```json
  {
    "iceServers": [
      { "urls": "turn:seu-servidor:3478", "username": "usuario", "credential": "senha" }
    ]
  }
  ```

  O TURN só retransmite pacotes já cifrados e não consegue ler o conteúdo.

## Linha de comando

```
.venv\Scripts\python.exe server.py [--public] [--port 8420] [--bind 0.0.0.0] [--no-browser]
```

## Estrutura

```
server.py              servidor HTTP + WebSocket (aiohttp): salas e repasse de sinalização
public/index.html      interface
public/css/app.css     estilos
public/js/app.js       navegação entre telas
public/js/host.js      quem transmite: captura, salas, conexões, qualidade
public/js/viewer.js    quem assiste: conexão, verificação, player, estatísticas
public/js/crypto.js    compromisso, código SAS, validação de impressões digitais, SHA-256
public/js/quality.js   predefinições e aplicação no encoder (sem renegociar)
public/js/stats.js     leitura de estatísticas WebRTC
public/js/signaling.js cliente WebSocket com reconexão
```

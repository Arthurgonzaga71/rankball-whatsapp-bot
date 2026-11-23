# Bot WhatsApp do RankBall

Serviço Node.js separado, executado com o segundo número de WhatsApp do Baba. O Supabase é a fonte oficial; o bot somente envia comandos e lê o estado atual.

## Estrutura para o Render

```
render.yaml                 # Blueprint do Render, na raiz do repositório
whatsapp-bot/
  package.json              # dependências e comando npm start
  .env.example              # somente modelo de variáveis locais
  .gitignore                # protege sessão e segredos
  src/index.mjs             # processo Baileys + sincronização Supabase
```

No Render, crie um **Blueprint** apontando para `render.yaml`. Ele já cria um Background Worker com `rootDir: whatsapp-bot` e disco persistente em `/var/data`. Preencha apenas os dois segredos pedidos pelo Render: `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`.

## Preparação

1. Execute a migration `202611230008_whatsapp_baileys.sql` no Supabase.
2. Copie `.env.example` para `.env` e informe a URL e a **service role key** do Supabase. Nunca use essa chave no frontend.
3. Cadastre o JID do grupo e os vínculos jogador/número. O JID normalmente tem o formato `5511999999999@s.whatsapp.net`; grupos usam o formato `123456@g.us`.
4. Em um servidor Node 20+, execute `npm install` e `npm start` dentro desta pasta. Leia o QR com o segundo número em WhatsApp > Dispositivos conectados.

## Comandos

- `PRESENTE`, `VOU`, `SIM` ou `CONFIRMO`: confirma a presença na próxima partida.
- `NÃO VOU`, `NAO VOU`, `NÃO` ou `AUSENTE`: registra ausência.
- `LISTA`: mostra os confirmados no grupo autorizado.

O bot aceita mensagens privadas de números vinculados e mensagens do grupo cadastrado. Mudanças realizadas pelo app são recebidas em tempo real e confirmadas ao número vinculado.

## Cadastro inicial no banco

Ao receber uma mensagem, o terminal mostra `chatJid` e `senderJid`. Com esses valores, o administrador pode cadastrar o grupo e vincular cada jogador:

```sql
insert into public.whatsapp_groups(organization_id,group_jid,name)
select id, 'COLE_O_CHAT_JID_DO_GRUPO', 'Baba'
from public.organizations where slug='rankball';

insert into public.whatsapp_player_links(organization_id,player_id,whatsapp_jid)
select o.id, 'ID_DO_JOGADOR', '5511999999999@s.whatsapp.net'
from public.organizations o where o.slug='rankball'
on conflict (organization_id,player_id) do update
set whatsapp_jid=excluded.whatsapp_jid, active=true, linked_at=now();
```

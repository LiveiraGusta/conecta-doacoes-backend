# Spec do Chat em Tempo Real — WebSocket

Complemento do Módulo 4. As rotas REST do `openapi.yaml` continuam sendo o contrato: histórico, envio, `?after=` para polling, confirmar e cancelar. O WebSocket só **empurra** o que acontece numa sala, para a tela atualizar sem esperar o próximo polling.

Antecipa parte do ADR-08 (WebSocket era V2). Os limites desta versão estão no fim deste documento.

## Resumo

| Item | Valor |
| --- | --- |
| URL | `wss://<api>/api/v1/chats/ws` (local: `ws://localhost:3333/api/v1/chats/ws`) |
| Formato | Texto JSON, uma mensagem por frame, até 16 KB |
| Autenticação | Cookie de sessão `cd_session` enviado pelo navegador no handshake, mais `Origin` permitido (ADR-13) |
| Quem conecta | `DONOR` e `NGO`; `ADMIN` é recusado |
| Envio de mensagem | Continua pelo REST: `POST /chats/:itemId/messages` |
| Fallback | Se a conexão cair, o frontend volta ao polling com `GET /chats/:itemId/messages?after=` |

A sessão vai no cookie httpOnly que o navegador já envia no handshake (ADR-13). O JS não tem o token, e nada vai na URL, que vazaria para logs de proxy. O servidor também confere o `Origin` contra `CORS_ORIGIN`, para outro site não abrir uma conexão com o cookie do usuário (*cross-site WebSocket hijacking*).

> Até a V1.1 a autenticação era a mensagem `{type:"auth", token}`. Ela saiu do protocolo: enviá-la agora gera `error` `VALIDATION_ERROR`.

## Fluxo

```text
cliente                                         API
  │── conecta (cookie cd_session + Origin) ─────▶│  confere Origin, valida o JWT e lê o usuário do banco
  │◀──────────────────── {type:"ready", user_id} ─│
  │── {type:"subscribe", item_id} ──────────────▶│  mesma regra de GET /chats/:itemId/messages
  │◀────────────── {type:"subscribed", item_id} ──│
  │                                              │
  │◀──── {type:"message.created", ...} ───────────│  alguém enviou pelo REST
  │◀──── {type:"item.status_changed", ...} ───────│  confirmou (DOADO) ou cancelou (DISPONIVEL)
  │◀──── {type:"unsubscribed", reason:"chat_closed"} ─│  só depois de um cancelamento
  │                                              │
  │◀──── {type:"unread.updated", ...} ────────────│  V1.1: sem precisar de subscribe
```

Uma conexão pode acompanhar até 50 salas ao mesmo tempo, por exemplo a lista de conversas inteira.

## Mensagens do cliente

| `type` | Campos | Efeito |
| --- | --- | --- |
| `subscribe` | `item_id` (UUID) | Passa a receber os eventos da sala. |
| `unsubscribe` | `item_id` | Para de receber. |
| `ping` | — | Responde `pong` (keep-alive de aplicação, opcional). |

## Mensagens do servidor

```jsonc
{ "type": "ready", "user_id": "uuid" }
{ "type": "subscribed", "item_id": "uuid" }
{ "type": "unsubscribed", "item_id": "uuid", "reason": "requested" | "chat_closed" }
{ "type": "pong" }

// Nova mensagem na sala. `message` tem o mesmo formato de Message no openapi.yaml.
{ "type": "message.created", "item_id": "uuid", "message": { "id", "item_id", "sender_id", "receiver_id", "message", "created_at" } }

// Mudança de status do item.
{
  "type": "item.status_changed",
  "item_id": "uuid",
  "previous_status": "EM_PROGRESSO",
  "status": "DOADO" | "DISPONIVEL",
  "changed_by": "DONOR" | "NGO",
  "reason": "string" | null,          // motivo do cancelamento, se houver
  "completed_at": "ISO 8601" | null   // preenchido quando status = DOADO
}

// V1.1 — Não lidas mudaram (mensagem recebida, mensagem enviada ou conversa marcada como lida).
// Chega em TODAS as conexões do usuário, inscritas ou não na sala: serve para o badge e para sincronizar abas.
// Mesmos números de GET /chats (unread_count) e GET /chats/unread.
{ "type": "unread.updated", "item_id": "uuid", "unread_count": 2, "unread_messages": 5, "unread_chats": 3 }

// Erro de uma mensagem específica. A conexão continua aberta.
{ "type": "error", "error": "FORBIDDEN", "message": "texto pronto para a UI", "item_id": "uuid?" }
```

Os códigos de `error` são os mesmos do REST:

| `error` | Quando |
| --- | --- |
| `VALIDATION_ERROR` | JSON inválido, `type` desconhecido, `item_id` que não é UUID ou limite de 50 salas |
| `ITEM_NOT_FOUND` | O item não existe |
| `FORBIDDEN` | O usuário não é o doador nem a ONG selecionada |
| `CHAT_CLOSED` | O item está `DISPONIVEL` e não há negociação aberta |

## Fechamento da conexão

| Código | Motivo |
| --- | --- |
| `4401` | Sem cookie de sessão, token inválido ou expirado, ou o usuário não existe mais |
| `4403` | O usuário é `ADMIN`, ou o `Origin` não está na lista do `CORS_ORIGIN` (ou falta) |
| `1001` | O servidor está reiniciando (deploy). O cliente reconecta. |

O servidor manda um `ping` de protocolo a cada 30 s e derruba conexões que não respondem. Os navegadores respondem sozinhos.

## Regras

- **Quem pode se inscrever** segue a mesma regra de `GET /chats/:itemId/messages`: só o doador e a ONG selecionada, com o item `EM_PROGRESSO` ou `DOADO`.
- **Cancelamento:** os dois lados recebem `item.status_changed` (`DISPONIVEL`) e em seguida `unsubscribed` com `chat_closed`. Se o doador escolher outra ONG depois, é uma sala nova, e cada lado precisa se inscrever de novo. Assim a ONG anterior não recebe nada da negociação seguinte.
- **Doação concluída:** `DOADO` mantém a inscrição, porque o histórico continua legível, mas não chegam mais mensagens, já que o envio é recusado com `CHAT_CLOSED`.
- **Não lidas (V1.1):** depois do `ready`, a conexão recebe `unread.updated` de todas as conversas do usuário, sem `subscribe`. Não lida é a mensagem recebida da outra parte da negociação atual depois da última leitura. Marcar como lida é pelo REST (`POST /chats/:itemId/read`), e enviar uma mensagem também marca a conversa como lida para quem enviou.
- **Ordem e duplicatas:** o frontend deduplica as mensagens pelo `id`. Ao reconectar, busca o que perdeu com `GET /chats/:itemId/messages?after=<created_at da última mensagem>`.

## Uso recomendado no frontend

1. Abrir a sala e carregar o histórico com `GET /chats/:itemId/messages`.
2. Conectar o WS (o navegador leva o cookie), esperar o `ready` e se inscrever na sala. Mensagens enviadas antes do `ready` esperam a autenticação.
3. Enviar mensagens pelo `POST` e acrescentar na tela o que chegar em `message.created`, deduplicando pelo `id`.
4. Com a sala aberta e visível, chamar `POST /chats/:itemId/read` ao abrir e a cada `message.created` recebido. O badge usa `GET /chats/unread` no boot e `unread.updated` depois.
5. Se o WS cair: ativar o polling de 3 s com `?after=` e tentar reconectar com backoff (1 s, 2 s, 5 s, 10 s). Ao reconectar, desligar o polling.

## Limites desta versão

- **Uma instância da API.** Os eventos circulam em memória (`core/realtime.ts`). Para escalar horizontalmente, a interface `RealtimeBus` recebe uma implementação com Redis ou Postgres `LISTEN/NOTIFY`, sem mudar o protocolo.
- **Sem push fora do app.** As não lidas chegam por `unread.updated` enquanto o app está aberto (V1.1). Notificação push (app fechado) continua na V2.

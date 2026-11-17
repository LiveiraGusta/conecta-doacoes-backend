# ADR-12: WebSocket no chat como canal de eventos, mantendo o REST como contrato

**Status:** Aceito
**Data:** 2026-11-17
**Decisores:** time de backend
**Altera:** ADR-08 (chat texto com polling de 3 s; WebSocket previsto para a V2)
**Protocolo:** [Spec do Chat em Tempo Real — WebSocket](../specs/Spec%20do%20Chat%20em%20Tempo%20Real%20—%20WebSocket.md)

## Contexto

O ADR-08 definiu o chat com polling de 3 s e deixou WebSocket para a V2. Na implementação da Fase 5 decidiu-se antecipar o tempo real, sem quebrar o contrato que o frontend já consome nem o plano de 2 dias.

## Decisão

1. **O REST continua sendo o contrato.** As rotas `GET/POST /chats/:itemId/messages`, `confirm-receipt` e `cancel` não mudam. O WebSocket em `/api/v1/chats/ws` só **empurra** eventos (`message.created` e `item.status_changed`), e o polling com `?after=` vira fallback.
2. ~~**A autenticação vem na primeira mensagem** (`{type:'auth', token}` em até 5 s), não na URL: o navegador não envia `Authorization` no handshake e um token na query string vazaria para logs.~~ **Alterado pelo [ADR-13](ADR-13-sessao-cookie.md):** a sessão passou a ser um cookie httpOnly, conferido no handshake junto com o `Origin`.
3. **A distribuição é em memória**, atrás da interface `RealtimeBus` (`src/core/realtime.ts`). Basta com 1 instância, o cenário do MVP.

## Opções consideradas

| Dimensão | Polling 3 s (ADR-08) | **WS como canal de eventos (escolhida)** | WS substitui o REST |
| --- | --- | --- | --- |
| Latência | até 3 s | imediata | imediata |
| Mudança no contrato | nenhuma | nenhuma (canal novo, aditivo) | quebra o contrato |
| Carga no banco | 1 query por sala a cada 3 s | só na escrita | só na escrita |
| Se a conexão cair | — | volta ao polling | precisa de reenvio e reconciliação próprios |
| Complexidade | baixa | média | alta |

Para a distribuição, a alternativa era Postgres `LISTEN/NOTIFY`. Ela funciona com várias instâncias, mas exige uma conexão direta ao Supabase (porta 5432, modo sessão), porque o pooler na 6543 não suporta `LISTEN`.

## Consequências

**Ficou mais fácil:**
- As mensagens e as mudanças de status aparecem na hora para os dois lados.
- O cancelamento fecha a sala no servidor (`unsubscribed` com `chat_closed`), e a ONG anterior não recebe nada da negociação seguinte.

**Ficou mais difícil:**
- O frontend precisa gerenciar reconexão e deduplicação por `id`, além do fallback.
- Escalar para mais de uma instância exige trocar o `RealtimeBus` (e o contador do rate limit) por Redis.

**A revisitar:**
- ~~Notificação fora da sala aberta (mensagens não lidas), quando entrar a V1.1.~~ Feito na V1.1: evento `unread.updated` num canal por usuário do `RealtimeBus`, sem `subscribe`.
- Implementação do `RealtimeBus` com Redis se a API passar a rodar com mais de uma instância.

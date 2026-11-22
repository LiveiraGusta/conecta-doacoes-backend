# ADR-13: Sessão em cookie httpOnly, com proteção anti-CSRF por header

**Status:** Aceito
**Data:** 2026-11-17
**Decisores:** responsável pelo produto e time de frontend/backend
**Altera:** ADR-12 (item 2: autenticação do WebSocket pela primeira mensagem)

## Contexto

Até a V1.1 o login devolvia `{ token, user }` e o cliente mandava `Authorization: Bearer <token>`. Na hora de planejar o frontend React, o responsável pelo produto escolheu guardar a sessão em cookie. Um cookie escrito pelo JavaScript não protege nada a mais que o `localStorage`: qualquer XSS lê os dois. Por isso a escolha foi um cookie **httpOnly emitido pelo backend**, que o JS do navegador nunca enxerga.

O cookie passa a ir sozinho em toda requisição, o que abre a porta para CSRF. Também muda o WebSocket: o navegador envia cookies no handshake, mas não o header `Authorization`.

## Decisão

1. **Sessão só por cookie.** Login e cadastros gravam `cd_session` (JWT de 7 dias) com `HttpOnly`, `SameSite=Lax`, `Path=/api/v1`, `Secure` em produção (`COOKIE_SECURE=true`) e `Domain` opcional (`COOKIE_DOMAIN`). O corpo da resposta vira `{ user }`. O header `Bearer` **não é mais aceito** (`@fastify/jwt` com `verify.onlyCookie`).
2. **`POST /auth/logout`** (pública, idempotente) apaga o cookie. Os atributos ficam num lugar só (`src/core/session-cookie.ts`), porque o navegador só apaga o cookie se o `clear` repetir os mesmos.
3. **Troca de senha** continua derrubando todas as sessões anteriores, mas devolve um cookie novo para a sessão atual. **Excluir a conta** apaga o cookie.
4. **Anti-CSRF:** toda requisição POST, PUT, PATCH ou DELETE precisa de `X-Requested-With: XMLHttpRequest`, inclusive login e cadastro. Sem ele: `403 CSRF_HEADER_MISSING`. Um formulário de outro site não consegue enviar esse header, e um `fetch` de outro site com ele cai no preflight do CORS. A checagem fica no `authPlugin`: nas rotas fechadas ela roda **depois** da autenticação, para que a falta de sessão continue sendo 401.
5. **CORS** com `credentials: true`, liberando `x-requested-with` e expondo `x-request-id` (o frontend mostra o id nas telas de erro).
6. **WebSocket:** a autenticação passa para o handshake. O servidor confere o `Origin` contra `CORS_ORIGIN` (proteção contra *cross-site WebSocket hijacking*) e o cookie, e responde `{type:"ready"}` sem esperar mensagem. Falhas fecham com 4401 (sessão) ou 4403 (Admin ou origem não permitida). A mensagem `{type:"auth"}` sai do protocolo. A rota continua `public` para o hook global: um 401 no upgrade chegaria ao navegador como 1006, sem motivo.
7. **Implantação no mesmo site:** frontend em `app.<domínio>` e API em `api.<domínio>`. Assim o cookie é *first-party* e o `SameSite=Lax` basta.

## Opções consideradas

| Dimensão | Bearer no `localStorage` (anterior) | Cookie escrito pelo JS | **Cookie httpOnly do backend (escolhida)** |
| --- | --- | --- | --- |
| Token legível por XSS | sim | sim | **não** |
| Risco de CSRF | não | não (o JS manda o header) | sim, mitigado por `SameSite=Lax` + header obrigatório |
| WebSocket | token na 1ª mensagem | token na 1ª mensagem | cookie no handshake + `Origin` |
| Mudança no backend | nenhuma | nenhuma | média |
| Logout | apagar no cliente | apagar no cliente | rota no servidor |

Para a hospedagem, a alternativa eram domínios diferentes (por exemplo `*.vercel.app` + `*.onrender.com`), com `SameSite=None; Secure; Partitioned`. Ela foi descartada na revisão técnica do plano por três motivos:
- o Safari bloqueia cookies de terceiros por padrão;
- `vercel.app` está na Public Suffix List, então nem subdomínios dele contam como o mesmo site;
- o rewrite da Vercel não repassa WebSocket.

## Consequências

**Ficou mais fácil:**
- Um XSS não consegue roubar a sessão.
- O cliente não guarda nem renova token: basta `credentials: 'include'` e o header anti-CSRF.
- Trocar a senha não desloga o aparelho atual.

**Ficou mais difícil:**
- Produção exige um domínio próprio com dois subdomínios. Os previews da Vercel não terão login real.
- Clientes que não são navegador (scripts, um futuro app mobile) precisam lidar com cookie e com o header. O Swagger UI ganhou um script que adiciona o header e envia o cookie.
- Os testes mandam a sessão por `cookie`. O `inject` dos testes já envia o header anti-CSRF; `ctx.rawInject` existe para testar a falta dele.

**A revisitar:**
- Se surgir um app mobile nativo, avaliar um fluxo próprio (Bearer com outro escopo, ou ticket para o WebSocket) em vez de reabrir o Bearer para o navegador.

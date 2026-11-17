# Guia de integração do frontend — Conecta Doações API

> **Para quem é:** uma IA (ou um dev) que vai construir o frontend consumindo esta API.
> O guia é organizado por **fluxos de ponta a ponta**, na ordem em que o usuário passa por eles.
> Para o detalhe de cada rota, os schemas são a fonte da verdade:
> - REST: [`specs/openapi.yaml`](specs/openapi.yaml) (34 rotas, OpenAPI 3.1)
> - Tempo real: [`specs/Spec do Chat em Tempo Real — WebSocket.md`](specs/Spec%20do%20Chat%20em%20Tempo%20Real%20—%20WebSocket.md)
>
> Versão da API coberta: **MVP (V1.0) + V1.1** (perfil, recuperação de senha, denúncias, mensagens não lidas) **+ sessão por cookie httpOnly** ([ADR-13](adr/ADR-13-sessao-cookie.md)).

## 0. Regras para quem implementa

1. **Não invente campos, rotas nem códigos de erro.** Se algo não está neste guia nem no `openapi.yaml`, a API não tem. Pergunte antes de supor.
2. **O `openapi.yaml` vence este guia** em caso de divergência. Os testes do backend validam toda resposta contra ele.
3. **Use a `message` do erro na UI.** A API devolve mensagens prontas em português. Use o `error` (código) só para decidir o *comportamento*: redirecionar, mostrar um botão, recarregar.
4. **A API é a dona das regras.** O frontend esconde botões por conveniência, mas sempre trata o erro que a API devolve. Exemplo: mesmo com o botão "Tenho interesse" escondido para uma ONG pendente, trate `403 NGO_NOT_APPROVED`.
5. **JSON em `snake_case`**, IDs UUID, datas ISO 8601 em UTC (`2026-11-17T13:45:12.345Z`). Formate para o fuso do usuário só na exibição.

---

## 1. Fundamentos

### 1.1 Endereços

| O quê | Desenvolvimento | Produção |
| --- | --- | --- |
| REST | `http://localhost:3333/api/v1` | `https://<api>/api/v1` |
| WebSocket | `ws://localhost:3333/api/v1/chats/ws` | `wss://<api>/api/v1/chats/ws` |
| Swagger (testar rotas no navegador) | `http://localhost:3333/docs` | desligado |
| Health | `GET http://localhost:3333/health` (fora de `/api/v1`) | idem |

- **CORS:** em dev, `http://localhost:5173` (porta padrão do Vite) é liberado automaticamente. Outras origens precisam entrar em `CORS_ORIGIN` no `.env` do backend. O CORS aceita credenciais (cookie) e expõe o `x-request-id`.
- **Produção no mesmo site:** frontend em `app.<domínio>` e API em `api.<domínio>`. Com domínios sem relação (ex.: `*.vercel.app` + `*.onrender.com`), o navegador trata o cookie de sessão como de terceiros, e o Safari o bloqueia. Em dev, `localhost:5173` e `localhost:3333` já são o mesmo site.
- Deixe a URL base em variável de ambiente do frontend (ex.: `VITE_API_URL`) e derive a do WebSocket dela (`http` → `ws`, `https` → `wss`).

### 1.2 Autenticação (cookie httpOnly)

- O login e os cadastros devolvem `{ user }` e gravam o cookie **`cd_session`** (`HttpOnly`, `SameSite=Lax`, `Path=/api/v1`, `Secure` em produção). O JavaScript **não vê nem guarda o token**: o navegador envia o cookie sozinho.
- Toda chamada usa **`credentials: 'include'`**. O header `Authorization: Bearer` **não é aceito**.
- **Anti-CSRF:** toda requisição `POST`, `PUT`, `PATCH` ou `DELETE` leva **`X-Requested-With: XMLHttpRequest`**, inclusive login e cadastro. Sem ele: `403 CSRF_HEADER_MISSING` (erro de integração, não de permissão).
- A sessão vale **7 dias** e **não há refresh**. Quando expirar, a API responde `401` e o usuário faz login de novo.
- **Sair:** `POST /auth/logout` → `204`. A rota apaga o cookie e funciona mesmo sem sessão. Depois, feche o WebSocket e limpe o cache.
- **Saber se há sessão:** `GET /auth/me`. Um `401` no boot significa visitante (ou sessão expirada), não um erro a mostrar.
- **Toda rota exige sessão**, exceto: `POST /auth/register/donor`, `POST /auth/register/ngo`, `POST /auth/login`, `POST /auth/logout`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `/health*` e o WebSocket (que confere o cookie no handshake).
- **Uma sessão válida pode passar a dar `401`**:
  - depois de redefinir a senha pelo e-mail (todas as sessões caem);
  - depois de trocar a senha (caem as **outras** sessões; a atual recebe um cookie novo);
  - depois de excluir a conta.

  Trate todo `401` igual: limpar o estado do usuário e ir para o login.

### 1.3 Formato de erro

Todo erro tem o mesmo formato:

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Dados inválidos.",
  "details": [{ "path": "password", "message": "A senha precisa de ao menos 1 letra e 1 número" }]
}
```

- `details` só aparece em `VALIDATION_ERROR`. O `path` é o nome do campo enviado, o que permite mostrar o erro embaixo do input certo.
- A resposta traz o cabeçalho `x-request-id` (exposto no CORS). Mostre-o em telas de erro inesperado (`500`) para facilitar o suporte.

Tratamento global recomendado (no cliente HTTP, antes de chegar na tela):

| Status | Ação global |
| --- | --- |
| `401` | Limpar o estado do usuário e ir para o login. Exceções: no `GET /auth/me` do boot, `401` indica visitante; nas telas de login e cadastro, `401 INVALID_CREDENTIALS` é erro de formulário |
| `403` | Mostrar `message`. Em `NGO_NOT_APPROVED`, apontar para a tela de status da ONG. `CSRF_HEADER_MISSING` indica cliente mal configurado (falta o header) |
| `404` | Mostrar "não encontrado" com `message` |
| `409` | Mostrar `message` **e recarregar o recurso**: o estado mudou no servidor (alguém agiu antes) |
| `413` | Arquivo grande demais (`PAYLOAD_TOO_LARGE`) |
| `429` | "Muitas requisições", desabilitar o botão por alguns segundos e tentar de novo |
| `5xx` | Mensagem genérica e `x-request-id` |

### 1.4 Paginação

Listas recebem `limit` (1–50, padrão 30) e `offset` (≥ 0) na query, e respondem `{ total, data: [...] }`. `total` é o total sem paginação. Há mais páginas enquanto `offset + data.length < total`.

### 1.5 Limites

| O quê | Limite |
| --- | --- |
| Requisições em geral | 120 por minuto, por IP |
| `/auth/*` (cadastro, login, esqueci/redefinir senha) | 10 por minuto, por IP |
| Publicar item | 10 por minuto, por usuário |
| Enviar mensagem | 30 por minuto, por usuário |
| Trocar senha / denunciar | 5 por minuto, por usuário |
| Corpo JSON | 1 MB |
| Arquivo (foto ou documento) | 5 MB cada. Fotos: JPG, PNG ou WEBP. Documento da ONG: PDF, JPG, PNG ou WEBP. O tipo é conferido pelo conteúdo, não pela extensão |
| Senha | 8 a 72 caracteres, com ao menos 1 letra e 1 número |

### 1.6 Cliente HTTP de referência

```ts
const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3333/api/v1';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string,
              public details?: { path: string; message: string }[], public requestId?: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-requested-with', 'XMLHttpRequest'); // anti-CSRF: obrigatório em POST/PUT/PATCH/DELETE
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  // FormData: NÃO defina content-type; o navegador põe o boundary do multipart.
  // credentials: 'include' faz o navegador enviar (e gravar) o cookie de sessão httpOnly.
  const res = await fetch(API + path, { ...init, headers, body, credentials: 'include' });
  if (res.status === 204 || res.status === 202) return undefined as T; // sem corpo
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) session.clear(); // limpa o usuário → tela de login
    throw new ApiError(res.status, data.error ?? 'INTERNAL_ERROR', data.message ?? 'Erro inesperado.',
                       data.details, res.headers.get('x-request-id') ?? undefined);
  }
  return data as T;
}
```

---

## 2. Perfis e o que cada um vê

| Perfil | Situação | O que pode fazer |
| --- | --- | --- |
| **DONOR** (doador) | — | Publicar itens, ver o feed da sua cidade, ver as ONGs interessadas, escolher uma, conversar, cancelar, denunciar, editar o perfil |
| **NGO** (ONG) | `PENDENTE_APROVACAO` | **Só leitura:** vê o feed, mas não demonstra interesse. Mostrar um aviso "Cadastro em análise" |
| **NGO** | `REJEITADO` | Igual à pendente, mais o motivo (`rejection_reason`) e a opção de **reenviar o documento** |
| **NGO** | `ATIVO` | Demonstrar interesse, conversar quando escolhida, confirmar recebimento, cancelar, denunciar |
| **ADMIN** | — | Moderar ONGs e denúncias. **Não** tem feed, itens, chat nem perfil editável (essas rotas respondem `403`) |

O perfil e o status da ONG vêm em `user.role` e `user.ngo_profile.status`. O `ngo_profile` só existe quando `role = NGO`.

Mapa de telas sugerido:

| Tela | DONOR | NGO | ADMIN |
| --- | --- | --- | --- |
| Login, cadastro, esqueci a senha, `/redefinir-senha` | ✓ | ✓ | login |
| Feed da cidade (+ detalhe do item) | ✓ | ✓ | — |
| Publicar item | ✓ | — | — |
| Meus itens / meus interesses (`/items/me`) | itens que doei | itens que curti | — |
| Interessadas de um item | dono | — | — |
| Conversas (lista + sala) com badge de não lidas | ✓ | ✓ | — |
| Perfil (editar, senha, excluir conta) | ✓ | ✓ (+ site, + reenviar documento) | — |
| Moderação de ONGs | — | — | ✓ |
| Fila de denúncias | — | — | ✓ |

---

## 3. Ciclo de vida de um item

```text
            select-ngo (doador)               confirm-receipt (ONG escolhida)
DISPONIVEL ─────────────────────▶ EM_PROGRESSO ───────────────────────────────▶ DOADO
     ▲                                  │
     └──────── cancel (doador ou ONG) ──┘   (o item volta para a vitrine)
```

| Status | Onde aparece | Chat |
| --- | --- | --- |
| `DISPONIVEL` | Feed. A ONG ativa pode curtir | Não existe. A sala responde `409 CHAT_CLOSED` ao doador e `403` aos outros |
| `EM_PROGRESSO` | Feed (sem botão de curtir) e conversas do doador e da ONG escolhida | Aberto: lê e envia |
| `DOADO` | Conversas, como histórico | **Só leitura.** Enviar responde `409 CHAT_CLOSED` |

Campos do contexto do usuário no feed e no detalhe:
- `has_user_interest`: esta ONG já curtiu. Sempre `false` para doador e para ONG não ativa.
- `is_selected`: esta ONG é a escolhida. Sempre `false` para doador.
- `interests_count`: quantas ONGs curtiram.
- `donor.name` vem **abreviado** ("Marina S."). O nome completo só aparece no chat.

---

## 4. Fluxos de ponta a ponta

### F1. Inicialização do app (boot)

1. Sempre: `GET /auth/me` → `{ user }`. O cookie vai sozinho, e o front não sabe de antemão se há sessão.
   - `200`: sessão válida. Guarde o `user`: ele diz o perfil, a cidade e o status da ONG.
   - `401`: sem sessão (visitante) ou sessão expirada. Mostre o login, sem mensagem de erro.
2. Se for DONOR ou NGO: abra o WebSocket (seção 5) e busque o badge com `GET /chats/unread` → `{ unread_messages, unread_chats }`.
3. Para uma ONG, rode o `GET /auth/me` de novo ao voltar para o app (foco da aba): é assim que ela descobre que foi aprovada ou rejeitada. Não há evento em tempo real de moderação.

### F2. Cadastro e login

**Doador:** `POST /auth/register/donor` com JSON:
```json
{ "name": "Marina Souza", "email": "marina@x.com", "password": "Senha1234", "city": "Campinas", "state": "SP" }
```

**ONG:** `POST /auth/register/ngo` em `multipart/form-data`:

| Campo | Regra |
| --- | --- |
| `name`, `email`, `password`, `city`, `state` | Iguais ao doador |
| `cnpj` | 14 dígitos, com ou sem máscara. Os dígitos verificadores são validados, e a API devolve o CNPJ mascarado |
| `website` | Opcional, `http(s)://…` |
| `document` | **1 arquivo**: PDF, JPG, PNG ou WEBP, até 5 MB |

```ts
const fd = new FormData();
Object.entries(campos).forEach(([k, v]) => v && fd.append(k, v));
fd.append('document', arquivo); // File do <input type="file">
const { user } = await api<AuthResponse>('/auth/register/ngo', { method: 'POST', body: fd });
```

- `201 { user }` + cookie de sessão: já entra logado. A ONG nasce `PENDENTE_APROVACAO`; mostre a tela "Cadastro em análise".
- Erros: `409 EMAIL_TAKEN`, `409 CNPJ_TAKEN`, `400 INVALID_DOCUMENT`, `400 VALIDATION_ERROR` (com `details` por campo).

**Login:** `POST /auth/login` `{ email, password }` → `200 { user }` + cookie de sessão. O erro é sempre o genérico `401 INVALID_CREDENTIALS`: não diga se foi o e-mail ou a senha.

O e-mail é normalizado pela API (espaços removidos e minúsculas), então não é preciso tratar isso no cliente.

### F3. Recuperação de senha

**Tela "Esqueci a senha":** `POST /auth/password/forgot` `{ email }` → **sempre `202`, sem corpo**, exista ou não a conta.
- Mostre sempre a mesma mensagem: *"Se houver uma conta com este e-mail, enviamos um link para criar uma senha nova. Ele vale por 30 minutos."*
- Pedidos repetidos em menos de 60 s não geram outro e-mail. A resposta continua `202`.

**Tela `/redefinir-senha?token=…`** (o link do e-mail aponta para `APP_URL/redefinir-senha?token=<token>`):
1. Leia o `token` da query string. Se faltar, mostre "link inválido" com um botão "Pedir um novo link".
2. Formulário de senha nova (com confirmação, validada só no cliente) → `POST /auth/password/reset` `{ token, new_password }`.
   - `204`: sucesso. Vá para o login com o aviso "Senha alterada. Entre com a senha nova". Todas as sessões antigas caíram.
   - `400 INVALID_RESET_TOKEN`: link inválido, expirado ou já usado. Ofereça "Pedir um novo link".
   - `400 VALIDATION_ERROR`: senha fora da regra (`details` no campo `new_password`).

> Em dev sem `RESEND_API_KEY`, o e-mail não é enviado: o link aparece no **log do backend**.

### F4. ONG: análise, rejeição e reenvio do documento

1. Com `user.ngo_profile.status = PENDENTE_APROVACAO`: banner "Seu cadastro está em análise". O feed funciona, mas sem o botão de interesse.
2. Com `REJEITADO`: mostre `rejection_reason` e um botão **Reenviar documento** → `PUT /profile/ngo-document` (multipart, campo `document`).
   - `200 { user }`: o status volta para `PENDENTE_APROVACAO` e o motivo é apagado. Atualize o `user` guardado.
   - `409 NGO_ALREADY_ACTIVE`: a ONG já foi aprovada. Recarregue `/auth/me`.
   - `400 INVALID_DOCUMENT`.
3. Com `ATIVO`: tudo liberado.

### F5. Admin: moderação de ONGs

1. Fila: `GET /admin/ngos?status=PENDENTE_APROVACAO` (padrão). As mais antigas vêm primeiro. Use `status=ATIVO` ou `status=REJEITADO` para as outras abas.
2. Cada ONG traz `document_url`, uma **URL assinada que expira em 10 minutos**. Abra em nova aba quando o admin clicar. Se expirar, recarregue a lista.
3. Decidir: `PATCH /admin/ngos/{ngo_profile_id}/status`
   - Aprovar: `{ "status": "ATIVO" }`
   - Rejeitar: `{ "status": "REJEITADO", "rejection_reason": "mínimo de 10 caracteres" }` (obrigatório ao rejeitar)
   - `200 { id, status, rejection_reason }`. Tire a ONG da fila. `404 NGO_NOT_FOUND`.

> Atenção: o parâmetro de rota é o `ngo_profile_id`, não o `user_id`.

### F6. Doador publica um item

`POST /items` em `multipart/form-data`:

| Campo | Regra |
| --- | --- |
| `title` | 3–255 |
| `description` | Opcional, até 2000 |
| `category` | `ROUPAS`, `BRINQUEDOS`, `ALIMENTOS` ou `LIVROS` |
| `city` + `state` | Opcionais, **sempre os dois juntos**. O padrão é a cidade/UF do doador |
| `photos` | **Exatamente 3 arquivos**, todos no campo `photos` (repita o `append`) |

```ts
const fd = new FormData();
fd.append('title', titulo); fd.append('category', categoria);
if (descricao) fd.append('description', descricao);
fotos.forEach((f) => fd.append('photos', f)); // 3 vezes
const item = await api<Item>('/items', { method: 'POST', body: fd });
```

- `201 Item`, com `photos[].photo_url` públicas. As fotos são convertidas para WEBP (até 1600 px), então não confie no tamanho original.
- Erros: `400 INVALID_PHOTO_COUNT` (≠ 3 fotos), `400 INVALID_PHOTO` (arquivo que não é imagem), `413 PAYLOAD_TOO_LARGE` (> 5 MB), `400 VALIDATION_ERROR`, `429`.
- Valide no cliente antes de enviar: 3 fotos, tipo de imagem e ≤ 5 MB cada. Mostre o preview das 3.

### F7. ONG navega o feed e demonstra interesse

1. Feed: `GET /items/feed?category=&search=&limit=&offset=`. Traz só os itens da **cidade/UF do usuário logado**, com status `DISPONIVEL` e `EM_PROGRESSO`, mais novos primeiro. `search` busca no título e na descrição (até 100 caracteres).
2. Detalhe: `GET /items/{id}` → `ItemDetail` (qualquer usuário logado, qualquer item).
3. **Tenho interesse** (só ONG `ATIVO`, item `DISPONIVEL` da mesma região): `POST /items/{id}/interest` → `201 Interest`. Marque `has_user_interest = true` e some 1 em `interests_count`.
   - `403 NGO_NOT_APPROVED`, `403 OUT_OF_REGION`, `409 ALREADY_INTERESTED` (trate como sucesso), `409 ITEM_NOT_AVAILABLE` (recarregue o item).
4. **Desfazer:** `DELETE /items/{id}/interest` → `204`.
   - `404 INTEREST_NOT_FOUND` (trate como sucesso), `409 ALREADY_SELECTED` (a ONG já foi escolhida; para desistir, ela precisa **cancelar a negociação**, F10).
5. "Meus interesses": `GET /items/me?status=` devolve, para a ONG, os itens que ela curtiu.

### F8. Doador escolhe a ONG (abre a negociação)

1. "Meus itens": `GET /items/me?status=` devolve os itens do doador. Mostre `interests_count` em cada um.
2. Interessadas: `GET /items/{id}/interests` → `{ item_id, total, interested_ngos[] }`, com as ONGs `ATIVO` primeiro e depois por data do like. Mostre nome, cidade, CNPJ, site e `ngo_status`. Desabilite "Escolher" nas que não estão `ATIVO`.
3. Escolher: `POST /items/{id}/select-ngo` `{ "ngo_id": "<uuid>" }` → `200 { item_id, status: "EM_PROGRESSO", selected_ngo_id, chat_room_url }`.
   - Navegue para a sala. `chat_room_url` é `/chats/<item_id>`, uma sugestão de rota do frontend.
   - `409 ITEM_NOT_AVAILABLE` (outra escolha chegou antes), `409 NGO_NOT_INTERESTED`, `409 NGO_NOT_ACTIVE`. Recarregue as interessadas.
4. A ONG escolhida descobre pela lista de conversas (`GET /chats`) e pelo `is_selected = true` no item. Ela também recebe `unread.updated` assim que o doador mandar a primeira mensagem.

### F9. Chat: lista de conversas, sala e não lidas

**Lista de conversas:** `GET /chats?status=EM_PROGRESSO|DOADO` → `{ total, data: ChatSummary[] }`, por atividade mais recente.
- Cada item traz `item_title`, `item_photo`, `item_status`, `counterpart { id, name, role }`, `last_message` (pode ser `null`) e **`unread_count`**.
- Badge global: `GET /chats/unread` → `{ unread_messages, unread_chats }`.

**Abrir a sala** (`/chats/:itemId`):
1. `GET /chats/{itemId}/messages` → `{ item, counterpart, messages[] }`, em ordem cronológica. Só vêm as mensagens da negociação **atual**.
2. Envie `{type:"subscribe", item_id}` no WebSocket (seção 5).
3. Marque como lida: `POST /chats/{itemId}/read` → `200 { unread_messages, unread_chats }`. Atualize o badge com a resposta e zere o `unread_count` dessa conversa.

**Enviar:** `POST /chats/{itemId}/messages` `{ "message": "1–2000 caracteres" }` → `201 Message`.
- Acrescente a mensagem na tela pela resposta **e** pelo evento `message.created`, **deduplicando pelo `id`**.
- Enviar já marca a conversa como lida para quem enviou.
- `409 CHAT_CLOSED`: a negociação acabou (doada ou cancelada). Recarregue a sala.

**Receber em tempo real:**
- `message.created` na sala aberta: acrescente e, se a aba estiver visível, chame `POST /chats/{itemId}/read`.
- `unread.updated`: chega em todas as conexões do usuário, mesmo sem inscrição na sala. Atualize o badge (`unread_messages`, `unread_chats`) e o `unread_count` da conversa `item_id` na lista.

**Sem WebSocket (caiu ou ainda não conectou):** faça polling a cada 3 s com `GET /chats/{itemId}/messages?after=<created_at da última mensagem>`, que devolve só as novas. Desligue o polling quando o WebSocket voltar.

> Marcar como lida é sempre uma chamada explícita. O `GET` das mensagens **não** marca nada. Chame `read` só com a sala aberta e visível.

### F10. Encerrar a negociação

**Confirmar recebimento** (só a ONG escolhida e `ATIVO`): `POST /items/{id}/confirm-receipt` → `200 { item_id, status: "DOADO", completed_at }`.
- A sala vira só leitura e os dois lados recebem `item.status_changed` (`status: "DOADO"`).
- `409 ITEM_NOT_IN_PROGRESS`.

**Cancelar** (doador dono ou ONG escolhida): `POST /items/{id}/cancel` com corpo opcional `{ "reason": "até 500 caracteres" }` → `200 { item_id, previous_status, current_status: "DISPONIVEL", cancelled_by, message }`.
- O item volta para a vitrine, e o doador pode escolher outra ONG entre as interessadas.
- Os dois lados recebem `item.status_changed` (`status: "DISPONIVEL"`, com `reason`) e em seguida `unsubscribed` com `reason: "chat_closed"`. Feche a sala e avise *"A negociação foi cancelada"*.
- Se o doador escolher outra ONG depois, é uma sala **nova**: a ONG anterior não vê mais nada dela.
- `409 ITEM_NOT_IN_PROGRESS`.

Peça confirmação nos dois botões ("Tem certeza?"): as duas ações são definitivas.

### F11. Denúncia

**Usuário** (doador ou ONG da negociação atual, item `EM_PROGRESSO` ou `DOADO`): botão "Denunciar" na sala → `POST /chats/{itemId}/report` `{ "reason": "10 a 1000 caracteres" }` → `201 Report`. A denúncia é sempre contra a outra parte.
- `409 ALREADY_REPORTED`: já existe uma denúncia aberta deste usuário sobre este item.
- `429`: no máximo 5 por minuto.
- **Importante para a UX:** depois de um cancelamento, a ONG que saiu não consegue mais denunciar. Na tela de cancelar, sugira *"Se houve abuso, denuncie antes de cancelar"*.

**Admin:**
1. Fila: `GET /admin/reports?status=ABERTA` (padrão; ou `RESOLVIDA`), as mais antigas primeiro. Cada uma traz `item { id, title, status }`, `reporter` e `reported`.
2. Detalhe: `GET /admin/reports/{id}` → denúncia, item, as duas partes **com e-mail**, `events` (histórico de status do item) e **todas** as mensagens do item, inclusive de negociações anteriores.
   - Se a denunciada for uma ONG, `reported.ngo_profile_id` permite ir direto à moderação dela (F5).
3. Resolver: `PATCH /admin/reports/{id}` `{ "status": "RESOLVIDA" }` → `200 Report`. Repetir a chamada não dá erro.

### F12. Perfil

- **Editar:** `PATCH /profile` com qualquer combinação de `name`, `city` + `state` (sempre juntos) e `website` (só ONG; `null` apaga) → `200 { user }`. **O e-mail não é editável.** Mudar a cidade muda o feed na hora: recarregue-o.
- **Trocar senha:** `PATCH /profile/password` `{ current_password, new_password }` → `204` com um **cookie novo** para esta sessão.
  - As **outras** sessões (outros aparelhos) caem. A atual continua logada sem nada a fazer. Se houver um WebSocket aberto, reconecte-o, para ele usar o cookie novo.
  - `400 INVALID_CURRENT_PASSWORD`, `400 SAME_PASSWORD`, `429` (5 por minuto).
- **Excluir conta:** `DELETE /profile` `{ "password": "..." }` → `204`, e a API apaga o cookie. Limpe o estado do usuário e vá para a tela inicial.
  - `409 HAS_ACTIVE_NEGOTIATIONS`: o usuário precisa concluir ou cancelar as negociações em andamento antes.
  - Explique as consequências na confirmação: a conta é anonimizada. Para o doador, os itens disponíveis são apagados; para a ONG, os interesses em itens abertos somem. O histórico de doações concluídas fica, com o nome "Usuário removido".

---

## 5. WebSocket (tempo real)

**Protocolo resumido** (detalhe na spec do WebSocket):

1. Conecte em `/api/v1/chats/ws`. O navegador envia o cookie de sessão e o `Origin` no handshake; **não há mensagem de autenticação**.
2. Receba `{ "type": "ready", "user_id" }`. A partir daqui chegam os `unread.updated`. Mensagens enviadas antes do `ready` esperam a autenticação.
3. Para cada sala aberta: `{ "type": "subscribe", "item_id" }` → `{ "type": "subscribed", "item_id" }`. O limite é 50 salas por conexão. Para sair: `{ "type": "unsubscribe", "item_id" }`.

| Evento do servidor | O que fazer |
| --- | --- |
| `message.created` `{ item_id, message }` | Acrescentar na sala (dedupe por `message.id`) |
| `item.status_changed` `{ item_id, previous_status, status, changed_by, reason, completed_at }` | `DOADO`: sala só leitura. `DISPONIVEL`: negociação cancelada |
| `unsubscribed` `{ item_id, reason: "chat_closed" }` | Fechar a sala (veio de um cancelamento) |
| `unread.updated` `{ item_id, unread_count, unread_messages, unread_chats }` | Atualizar o badge e o contador da conversa |
| `error` `{ error, message, item_id? }` | Erro de uma mensagem específica (ex.: `FORBIDDEN` no subscribe). A conexão continua |

| Fechamento | Significado | Ação |
| --- | --- | --- |
| `4401` | Sem sessão, ou sessão inválida ou expirada | Não reconectar: tratar como `401` |
| `4403` | Usuário ADMIN, ou `Origin` não permitido | Não reconectar. Admin não usa o WebSocket; `Origin` errado é configuração (`CORS_ORIGIN`) |
| `1001` | Servidor reiniciando (deploy) | Reconectar |
| Outros | Queda de rede | Reconectar com backoff |

**Cliente de referência:**

```ts
type Handler = (msg: any) => void;

export function connectRealtime(isLoggedIn: () => boolean, onEvent: Handler) {
  const url = API.replace(/^http/, 'ws') + '/chats/ws';
  const rooms = new Set<string>();
  const delays = [1000, 2000, 5000, 10000];
  let ws: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;

  function open() {
    if (!isLoggedIn() || stopped) return;
    ws = new WebSocket(url); // o navegador envia o cookie de sessão no handshake
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ready') {
        attempt = 0;
        rooms.forEach((id) => ws!.send(JSON.stringify({ type: 'subscribe', item_id: id })));
        onEvent({ type: 'connected' }); // desligar polling; recuperar o perdido com ?after=
      }
      onEvent(msg);
    };
    ws.onclose = (e) => {
      onEvent({ type: 'disconnected' }); // ligar polling de 3 s nas salas abertas
      if (stopped || e.code === 4401 || e.code === 4403) return; // 4401 → fluxo de 401
      setTimeout(open, delays[Math.min(attempt++, delays.length - 1)]);
    };
  }
  open();

  return {
    join(itemId: string) {
      rooms.add(itemId);
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'subscribe', item_id: itemId }));
    },
    leave(itemId: string) {
      rooms.delete(itemId);
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'unsubscribe', item_id: itemId }));
    },
    close() { stopped = true; ws?.close(); },
  };
}
```

Ao reconectar, busque o que se perdeu em cada sala aberta com `GET /chats/{itemId}/messages?after=<created_at da última mensagem>` e o badge com `GET /chats/unread`.

---

## 6. Catálogo de códigos de erro

| Código | Status | Onde aparece | Ação sugerida na UI |
| --- | --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Qualquer formulário | Erros por campo a partir de `details[].path` |
| `INVALID_PHOTO_COUNT` | 400 | Publicar item | "Envie exatamente 3 fotos" |
| `INVALID_PHOTO` | 400 | Publicar item | Indicar o arquivo inválido |
| `INVALID_DOCUMENT` | 400 | Cadastro de ONG, reenvio de documento | Pedir outro arquivo |
| `INVALID_CURRENT_PASSWORD` | 400 | Trocar senha, excluir conta | Erro no campo de senha atual |
| `SAME_PASSWORD` | 400 | Trocar senha | Erro no campo de senha nova |
| `INVALID_RESET_TOKEN` | 400 | Redefinir senha | Botão "Pedir um novo link" |
| `UNAUTHORIZED` | 401 | Qualquer rota | Limpar a sessão → login (no `GET /auth/me` do boot: visitante) |
| `INVALID_CREDENTIALS` | 401 | Login | Erro genérico no formulário |
| `FORBIDDEN` | 403 | Rotas de item/chat/admin | Mostrar `message` |
| `CSRF_HEADER_MISSING` | 403 | Qualquer POST/PUT/PATCH/DELETE sem `X-Requested-With` | Bug do cliente: o cliente HTTP deve sempre mandar o header |
| `NGO_NOT_APPROVED` | 403 | Interesse, confirmar recebimento | Levar à tela de status da ONG |
| `OUT_OF_REGION` | 403 | Interesse | Mostrar `message` |
| `NOT_FOUND` | 404 | Genérico | Tela de não encontrado |
| `ITEM_NOT_FOUND` | 404 | Item, chat, denúncia | Voltar para a lista |
| `NGO_NOT_FOUND` | 404 | Moderação | Recarregar a fila |
| `INTEREST_NOT_FOUND` | 404 | Desfazer interesse | Tratar como sucesso |
| `REPORT_NOT_FOUND` | 404 | Denúncias (admin) | Recarregar a fila |
| `EMAIL_TAKEN` | 409 | Cadastro | Erro no campo e-mail + link "Entrar" |
| `CNPJ_TAKEN` | 409 | Cadastro de ONG | Erro no campo CNPJ |
| `ALREADY_INTERESTED` | 409 | Interesse | Tratar como sucesso |
| `ALREADY_SELECTED` | 409 | Desfazer interesse | Explicar que precisa cancelar a negociação |
| `ITEM_NOT_AVAILABLE` | 409 | Interesse, escolher ONG | Recarregar o item |
| `ITEM_NOT_IN_PROGRESS` | 409 | Confirmar, cancelar | Recarregar a sala |
| `NGO_NOT_INTERESTED` | 409 | Escolher ONG | Recarregar as interessadas |
| `NGO_NOT_ACTIVE` | 409 | Escolher ONG | Recarregar as interessadas |
| `NGO_ALREADY_ACTIVE` | 409 | Reenviar documento | Recarregar `/auth/me` |
| `HAS_ACTIVE_NEGOTIATIONS` | 409 | Excluir conta | Levar para as conversas em andamento |
| `ALREADY_REPORTED` | 409 | Denunciar | "Você já denunciou esta negociação" |
| `CHAT_CLOSED` | 409 | Sala, enviar, marcar como lida, denunciar | Recarregar a sala / modo só leitura |
| `CONFLICT` | 409 | Genérico | Recarregar |
| `PAYLOAD_TOO_LARGE` | 413 | Uploads | "Arquivo maior que 5 MB" |
| `TOO_MANY_REQUESTS` | 429 | Qualquer rota | Aguardar e tentar de novo |
| `INTERNAL_ERROR` | 500 | Qualquer rota | Mensagem genérica + `x-request-id` |
| `SERVICE_UNAVAILABLE` | 503 | Servidor sobrecarregado | Tentar de novo em alguns segundos |

---

## 7. Armadilhas comuns

- **Upload com `content-type` manual.** Em `FormData`, não defina o `content-type`: o navegador precisa pôr o `boundary`.
- **Fotos em campos diferentes.** As 3 fotos vão todas no campo `photos`, e não em `photo1`, `photo2`, `photo3`.
- **`city` sem `state`** (ou o contrário) em `POST /items` e `PATCH /profile` dá `400`. Envie os dois ou nenhum.
- **Esquecer `credentials: 'include'`.** Sem ele, o navegador não envia nem grava o cookie, e tudo dá `401`.
- **Esquecer o `X-Requested-With`.** Toda escrita volta `403 CSRF_HEADER_MISSING`.
- **Tentar ler o token no JS.** O cookie é httpOnly: o estado de "logado" vem do `GET /auth/me`.
- **Front e API em domínios sem relação em produção.** O cookie vira de terceiros e o Safari o bloqueia. Use `app.<domínio>` + `api.<domínio>`.
- **Esperar corpo em `202`/`204`.** `forgot`, `reset`, `logout`, trocar senha, excluir conta e desfazer interesse não têm corpo.
- **Mensagem duplicada no chat.** Ela chega pela resposta do `POST` e pelo `message.created`. Deduplique pelo `id`.
- **Marcar como lida com a aba em segundo plano.** Só chame `read` com a sala visível (`document.visibilityState === 'visible'`).
- **Esperar evento de aprovação da ONG.** Não existe: refaça o `GET /auth/me` ao focar o app.
- **Usar o `user_id` na moderação.** A rota de status da ONG usa o `ngo_profile_id`.
- **Nome do doador no feed.** Vem abreviado de propósito ("Marina S.").

---

## 8. Ambiente de desenvolvimento

1. Backend: siga o README (`docker compose up -d`, `npm run migrate`, `npm run seed`, `npm run dev`). A API sobe em `http://localhost:3333`.
2. Contas de demonstração (com `SEED_DEMO=true` no seed), senha `Demo1234`:

| Perfil | E-mail |
| --- | --- |
| Doadora (tem 6 itens publicados) | `doadora@demo.conectadoacoes.local` |
| ONG aprovada | `ong.ativa@demo.conectadoacoes.local` |
| ONG em análise | `ong.pendente@demo.conectadoacoes.local` |
| Admin | `ADMIN_EMAIL` / `ADMIN_PASSWORD` do `.env` do backend |

3. Esses e-mails são fictícios: a recuperação de senha deles não chega por e-mail. Pegue o link no log do backend.
4. Para inspecionar ou testar uma rota isolada, use o Swagger em `http://localhost:3333/docs`.

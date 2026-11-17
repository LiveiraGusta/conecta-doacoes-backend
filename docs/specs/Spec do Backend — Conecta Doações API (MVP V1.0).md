# Spec do Backend — Conecta Doações API (MVP V1.0)

Nov 16, 2026 · @Liveira

## Visão geral

A API é um serviço Node + Fastify + TypeScript que implementa os 4 módulos REST da spec do produto (`/api/v1`), usando o Supabase apenas como Postgres e Storage. Este documento detalha *como* construir; os payloads de request/response continuam valendo como estão na spec do produto, e aqui só aparecem as diferenças.

| Camada | Escolha |
| --- | --- |
| Runtime | Node 20 LTS, TypeScript em modo `strict` |
| Framework | Fastify 5 com `@fastify/jwt`, `@fastify/multipart`, `@fastify/cors`, `@fastify/rate-limit` |
| Validação | Zod + `fastify-type-provider-zod` (mesmos schemas do frontend) |
| Banco | Supabase Postgres via `postgres` (porsager), SQL escrito à mão, migrações em `.sql` numeradas |
| Arquivos | Supabase Storage via `@supabase/supabase-js` com service role key, só no servidor |
| Imagens | `sharp` para reconverter e limitar fotos em `.webp` |
| Senhas | `bcrypt` (custo 10) |
| Testes | Vitest + `app.inject()` do Fastify contra um banco de teste |
| Deploy | Render ou Railway (processo contínuo), Node build com `tsup` |

Princípios:

- **A API é a única porta.** O frontend nunca fala com o Supabase; Supabase Auth e RLS ficam desligados.
- **Regra de negócio no serviço, não na rota.** Rotas validam e delegam; serviços falam SQL; nada de lógica em componentes de UI do outro lado (ADR-01).
- **Transições de estado são atômicas.** Toda mudança de `items.status` é um `UPDATE ... WHERE status = <esperado>` dentro de transação, com evento em `item_events`.
- **Contrato é lei.** Mudou um payload, muda primeiro a spec do produto.

> **Atualizações da implementação (17/11/2026)**
>
> - **Estrutura:** a organização em `routes`/`schemas`/`service` com SQL no service foi substituída pelo [ADR-11](../adr/ADR-11-camadas.md): routes → controller → service → repository + dto, com o SQL só no repository. A seção "Estrutura e configuração" abaixo descreve a versão anterior; a atual está no README.
> - **Chat em tempo real:** além do polling, há um WebSocket de eventos em `/api/v1/chats/ws` ([ADR-12](../adr/ADR-12-chat-websocket.md)).
> - **SQL do `cancel`:** o CTE com `FOR UPDATE` da seção "Máquina de estados" devolve `NULL` em `ngo_id`, porque a leitura com lock segue a versão já atualizada da linha. A implementação trava e lê a ONG num comando e faz o `UPDATE` em seguida, na mesma transação.
> - **Escopo:** Denúncias e o módulo Perfil ficaram para a V1.1. A tabela `reports` já existe, criada pela migração 002.

## Arquitetura

Um único processo Fastify em camadas: plugins e guards na entrada, um módulo por área da spec e um `core` compartilhado que é o único a falar com o Supabase.

&#91;embedded content: arquitetura da API · camadas e serviços externos\]

A única ligação direta do navegador com o Supabase é a leitura das fotos públicas pela URL; documentos de ONG só saem por URL assinada gerada pela API.

## Estrutura e configuração

Um módulo por área da spec, cada um com rotas, schemas e serviço separados; `core` guarda o que todos usam.

```text
api/
├─ migrations/
│  ├─ 001_schema.sql
│  ├─ 002_events_reports_indexes.sql
│  └─ seed.ts
├─ src/
│  ├─ app.ts              # monta o Fastify, registra plugins e módulos
│  ├─ server.ts           # lê env e chama listen()
│  ├─ core/
│  │  ├─ env.ts           # schema Zod das variáveis de ambiente
│  │  ├─ db.ts            # cliente postgres + helper tx()
│  │  ├─ storage.ts       # upload, remoção e URL assinada
│  │  ├─ errors.ts        # AppError + handler global
│  │  ├─ auth.ts          # plugin JWT, authenticate, requireRole, requireActiveNgo
│  │  └─ images.ts        # sharp: valida e converte para webp
│  └─ modules/
│     ├─ auth/            # routes.ts, schemas.ts, service.ts
│     ├─ admin/
│     ├─ items/           # publicar, feed, me, confirm, cancel
│     ├─ interests/       # like, listar, select-ngo
│     └─ chats/           # conversas, mensagens, denúncia
└─ test/
   ├─ helpers.ts          # app de teste, usuários e tokens prontos
   └─ *.test.ts
```

| Variável | Exemplo | Uso |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://...pooler.supabase.com:6543/postgres` | Conexão pelo pooler do Supabase |
| `SUPABASE_URL` | `https://xxxx.supabase.co` | Storage |
| `SUPABASE_SERVICE_ROLE_KEY` | segredo | Storage, só no servidor |
| `JWT_SECRET` | 32+ caracteres aleatórios | Assinatura dos tokens |
| `JWT_EXPIRES_IN` | `7d` | Validade do token |
| `CORS_ORIGIN` | `https://conectadoacoes.vercel.app` | Origem do frontend |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Lidos só pelo seed |
| `PORT` | `3333` | Porta HTTP |

`env.ts` valida tudo com Zod no boot: variável faltando derruba o processo com mensagem clara, em vez de falhar na primeira requisição.

## Modelo de dados

`001_schema.sql` é o schema da spec do produto sem mudanças, exceto trocar `uuid-ossp` por nada (o `gen_random_uuid()` é nativo no Postgres do Supabase). `002` aplica as correções levantadas na Fase 0 do roadmap e duas que a própria spec pede sem prever coluna:

- `items.completed_at` — o `confirm-receipt` devolve essa data, mas a tabela não tinha onde guardá-la.
- `users.created_at` é o que preenche o `created_at` da listagem de ONGs pendentes; `ngo_profiles` não tem data própria.
- `ngo_profiles.document_url` passa a guardar o **caminho** no bucket privado (`ngo-docs/<user_id>/<uuid>.pdf`); a API devolve nesse campo uma URL assinada de 10 minutos, só para o Admin.

```sql
-- 002_events_reports_indexes.sql
ALTER TABLE items ADD COLUMN completed_at TIMESTAMPTZ;

CREATE TABLE item_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  from_status VARCHAR(30),
  to_status VARCHAR(30) NOT NULL,
  actor_id UUID REFERENCES users(id),
  ngo_id UUID REFERENCES users(id),        -- ONG envolvida na negociação
  reason TEXT,                             -- motivo opcional do cancelamento
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(id),
  reported_id UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'ABERTA' CHECK (status IN ('ABERTA', 'RESOLVIDA')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_items_feed ON items (state, city, status, created_at DESC);
CREATE INDEX idx_items_donor ON items (donor_id);
CREATE INDEX idx_interests_item ON item_interests (item_id);
CREATE INDEX idx_interests_ngo ON item_interests (ngo_id);
CREATE INDEX idx_messages_item ON chat_messages (item_id, created_at);
CREATE INDEX idx_photos_item ON item_photos (item_id);
CREATE UNIQUE INDEX idx_ngo_profiles_user ON ngo_profiles (user_id);
```

**Isolamento do chat por negociação.** Mensagens continuam ligadas ao `item_id`, mas toda leitura filtra pelo par atual. Assim, se o doador cancela e escolhe outra ONG, a nova ONG não vê a conversa anterior, e o Admin continua vendo tudo:

```sql
SELECT id, sender_id, message, created_at
FROM chat_messages
WHERE item_id = $1
  AND sender_id IN ($2, $3) AND receiver_id IN ($2, $3)   -- $2 = donor_id, $3 = selected_ngo_id
  AND ($4::timestamptz IS NULL OR created_at > $4)        -- ?after= do polling
ORDER BY created_at ASC;
```

Limitação aceita: se o doador escolher a *mesma* ONG de novo depois de cancelar, a conversa antiga reaparece. Para o MVP isso é até desejável.

## Autenticação e autorização

Token JWT HS256 sem refresh token: validade de 7 dias, guardado pelo frontend e enviado em `Authorization: Bearer`. O payload é mínimo e o resto vem do banco a cada requisição, para que aprovar ou rejeitar uma ONG valha na hora, sem novo login.

```ts
// payload do token
{ sub: string /* users.id */, role: 'DONOR' | 'NGO' | 'ADMIN' }

// request.user depois de authenticate()
{ id, role, city, state, ngoStatus?: 'PENDENTE_APROVACAO' | 'ATIVO' | 'REJEITADO' }
```

Regras de cadastro e login:

- E-mail normalizado (`trim` + minúsculas) antes de gravar e de buscar; duplicado = `409 EMAIL_TAKEN`.
- Senha: mínimo 8 caracteres, com letra e número; hash `bcrypt` custo 10.
- CNPJ: aceita com ou sem máscara, valida os dígitos verificadores e grava mascarado (`12.345.678/0001-99`); duplicado = `409 CNPJ_TAKEN`.
- Login com credencial errada responde sempre `401 INVALID_CREDENTIALS`, sem dizer se o e-mail existe.
- `ADMIN` só nasce pelo seed. Rate limit de 10 tentativas por minuto por IP nas rotas `/auth/*`.

Três guards, usados como `preHandler`:

| Guard | Recusa com |
| --- | --- |
| `authenticate` | `401 UNAUTHORIZED` (token ausente, inválido ou usuário apagado) |
| `requireRole(...roles)` | `403 FORBIDDEN` |
| `requireActiveNgo` | `403 NGO_NOT_APPROVED` (ONG pendente ou rejeitada) |

Checagens de dono (é o doador do item? é a ONG selecionada?) ficam no serviço, porque dependem do item carregado, e respondem `403 FORBIDDEN`. Item que não existe responde `404 ITEM_NOT_FOUND`.

| Rota | DONOR | NGO pendente | NGO ativa | ADMIN |
| --- | --- | --- | --- | --- |
| `POST /items` | sim | não | não | não |
| `GET /items/feed` | sim | sim (só leitura) | sim | não |
| `GET /items/me` | sim | sim | sim | não |
| `POST /items/:id/interest` | não | não | sim | não |
| `GET /items/:id/interests` | dono | não | não | não |
| `POST /items/:id/select-ngo` | dono | não | não | não |
| `GET /chats`, `GET/POST /chats/:id/messages` | participante | não | participante | não |
| `POST /items/:id/confirm-receipt` | não | não | selecionada | não |
| `POST /items/:id/cancel` | dono | não | selecionada | não |
| `POST /chats/:id/report` | participante | não | participante | não |
| `/admin/*` | não | não | não | sim |

O Admin lê qualquer conversa só por `GET /admin/reports/:id`, que traz o histórico completo do item denunciado.

## Máquina de estados

Três rotas mudam `items.status`, e cada uma é um único `UPDATE` condicional dentro de transação: se zero linhas forem afetadas, alguém chegou antes e a rota responde `409`. Não existe "ler o status, checar no JS e depois gravar".

| Rota | De | Para | Quem | Condições extras | Conflito |
| --- | --- | --- | --- | --- | --- |
| `POST /items` | — | `DISPONIVEL` | doador | 3 fotos válidas | — |
| `select-ngo` | `DISPONIVEL` | `EM_PROGRESSO` | dono do item | a ONG tem registro em `item_interests` e ainda está `ATIVO` | `409 ITEM_NOT_AVAILABLE` |
| `cancel` | `EM_PROGRESSO` | `DISPONIVEL` (evento `CANCELADO`) | dono ou ONG selecionada | — | `409 ITEM_NOT_IN_PROGRESS` |
| `confirm-receipt` | `EM_PROGRESSO` | `DOADO` | ONG selecionada | — | `409 ITEM_NOT_IN_PROGRESS` |

`DOADO` é final: nenhuma rota sai dele. `CANCELADO` nunca fica gravado em `items.status`; ele existe só em `item_events`, como manda o ADR-10.

```sql
-- select-ngo ($1 item, $2 donor, $3 ngo)
UPDATE items i SET status = 'EM_PROGRESSO', selected_ngo_id = $3
WHERE i.id = $1 AND i.donor_id = $2 AND i.status = 'DISPONIVEL'
  AND EXISTS (SELECT 1 FROM item_interests WHERE item_id = $1 AND ngo_id = $3)
  AND EXISTS (SELECT 1 FROM ngo_profiles WHERE user_id = $3 AND status = 'ATIVO')
RETURNING i.id, i.status, i.selected_ngo_id;

-- cancel ($1 item, $2 usuário que cancela), dois comandos na mesma transação.
-- (Um CTE com FOR UPDATE no mesmo UPDATE devolve NULL: o lock segue a versão já atualizada.)
SELECT selected_ngo_id AS ngo_id FROM items WHERE id = $1 FOR UPDATE;
UPDATE items SET status = 'DISPONIVEL', selected_ngo_id = NULL
WHERE id = $1 AND status = 'EM_PROGRESSO' AND (donor_id = $2 OR selected_ngo_id = $2)
RETURNING id;
-- em seguida, na mesma transação:
-- INSERT INTO item_events (item_id, from_status, to_status, actor_id, ngo_id)
-- VALUES ($1, 'EM_PROGRESSO', 'CANCELADO', $2, ngo_id), ($1, 'CANCELADO', 'DISPONIVEL', $2, ngo_id);

-- confirm-receipt ($1 item, $2 ngo)
UPDATE items SET status = 'DOADO', completed_at = NOW()
WHERE id = $1 AND status = 'EM_PROGRESSO' AND selected_ngo_id = $2
RETURNING id, status, completed_at;
```

Quando o `UPDATE` volta vazio, o serviço faz uma leitura simples do item só para escolher o erro certo: `404` se não existe, `403` se o usuário não é parte, `409` se o status não bate. A ONG selecionada que estava `ATIVO` e depois foi rejeitada pelo Admin ainda pode cancelar, mas não pode confirmar (o `requireActiveNgo` barra antes).

## Endpoints

Os payloads de sucesso são os da spec do produto. Esta tabela só acrescenta o que a spec não diz: validação de entrada e os erros específicos de cada rota. Os erros gerais (`401`, `403 FORBIDDEN`, `404 ITEM_NOT_FOUND`, `400 VALIDATION_ERROR`) valem para todas e não se repetem aqui.

| Rota | Validação | Erros específicos |
| --- | --- | --- |
| `POST /auth/register/donor` | nome 2–255; e-mail válido; senha ≥ 8 com letra e número; UF na lista; cidade não vazia | `409 EMAIL_TAKEN` |
| `POST /auth/register/ngo` | igual ao doador + CNPJ válido, site URL opcional, `document` PDF/JPG/PNG/WEBP ≤ 5 MB | `409 EMAIL_TAKEN`, `409 CNPJ_TAKEN`, `400 INVALID_DOCUMENT` |
| `POST /auth/login` | e-mail e senha presentes | `401 INVALID_CREDENTIALS`, `429 TOO_MANY_REQUESTS` |
| `GET /auth/me` *(nova)* | — | — |
| `GET /admin/ngos` | `status` opcional, default `PENDENTE_APROVACAO` | — |
| `PATCH /admin/ngos/:id/status` | `status` ∈ {`ATIVO`, `REJEITADO`}; `rejection_reason` obrigatório (≥ 10 caracteres) se `REJEITADO` | `404 NGO_NOT_FOUND` |
| `POST /items` | título 3–255; descrição ≤ 2.000; categoria do enum; `photos` = exatamente 3 imagens ≤ 5 MB | `400 INVALID_PHOTO_COUNT`, `400 INVALID_PHOTO` |
| `GET /items/feed` | `category` do enum; `search` ≤ 100 caracteres (ILIKE em título e descrição); `limit` 1–50, default 30; `offset` ≥ 0 | — |
| `GET /items/me` | igual ao feed, sem `search` | — |
| `POST /items/:id/interest` | item na mesma cidade/UF da ONG e `DISPONIVEL` | `409 ALREADY_INTERESTED`, `409 ITEM_NOT_AVAILABLE`, `403 OUT_OF_REGION` |
| `GET /items/:id/interests` | — | — |
| `POST /items/:id/select-ngo` | `ngo_id` UUID | `409 ITEM_NOT_AVAILABLE`, `409 NGO_NOT_INTERESTED` |
| `GET /chats` | — | — |
| `GET /chats/:itemId/messages` | `after` ISO opcional | `409 CHAT_CLOSED` se o item está `DISPONIVEL` |
| `POST /chats/:itemId/messages` | `message` 1–2.000 caracteres após `trim` | `409 CHAT_CLOSED` se o item não está `EM_PROGRESSO` |
| `POST /items/:id/confirm-receipt` | — | `409 ITEM_NOT_IN_PROGRESS` |
| `POST /items/:id/cancel` | — | `409 ITEM_NOT_IN_PROGRESS` |
| `POST /chats/:itemId/report` *(nova)* | `reason` 10–1.000 | `409 ALREADY_REPORTED` (um aberto por usuário e item) |
| `GET /admin/reports` *(nova)* | `status` opcional | — |
| `GET /admin/reports/:id` *(nova)* | — | `404 REPORT_NOT_FOUND` |
| `PATCH /admin/reports/:id` *(nova)* | `status` = `RESOLVIDA` | `404 REPORT_NOT_FOUND` |

Detalhes que a spec deixa implícitos:

- **`GET /auth/me`** devolve o mesmo objeto `user` do login. O frontend usa no boot para restaurar a sessão e ver se a ONG foi aprovada.
- **Feed:** ordena por `created_at DESC`; `total` é a contagem sem `limit`; o nome do doador sai abreviado ("Marina S."); a ONG pendente recebe o feed com `has_user_interest = false` e o frontend esconde o botão.
- **`interest` fora da região:** a ONG não vê esses itens no feed, mas a rota checa de novo, porque o `itemId` pode vir de qualquer lugar.
- **`GET /chats`:** lista itens `EM_PROGRESSO` e `DOADO` em que o usuário é doador ou `selected_ngo_id`; `last_message` pode ser `null`.
- **Leitura de chat de item `DOADO`:** permitida (histórico), envio bloqueado.
- **`GET /admin/reports/:id`** traz a denúncia, o item, os dois usuários e todas as mensagens do item, sem o filtro por par.

## Upload de arquivos

O upload passa pela API em `multipart/form-data`, com o arquivo inteiro em memória (no máximo 3 × 5 MB por requisição), e só vai para o Storage depois de validado.

|  | Fotos de item | Documento da ONG |
| --- | --- | --- |
| Bucket | `items` (público) | `ngo-docs` (privado) |
| Caminho | `items/<item_id>/<uuid>.webp` | `ngo-docs/<user_id>/<uuid>.<ext>` |
| Tipos aceitos | JPG, PNG, WEBP | PDF, JPG, PNG, WEBP |
| Limite | 5 MB por foto, exatamente 3 | 5 MB, exatamente 1 |
| Processamento | `sharp`: rotação EXIF, maior lado em 1.600 px, `.webp` qualidade 80, metadados removidos | nenhum |
| Leitura | URL pública do Storage | URL assinada de 10 min, só em rotas `/admin` |

Fluxo do `POST /items`:

1. `@fastify/multipart` com `limits: { fileSize: 5 MB, files: 3, fields: 10 }`; passou de 3 arquivos = `400 INVALID_PHOTO_COUNT`, passou de 5 MB = `400 INVALID_PHOTO`.
2. Valida os campos de texto com Zod e conta os arquivos: diferente de 3 = `400 INVALID_PHOTO_COUNT`.
3. Confere o tipo pelos bytes (o `sharp` falha ao abrir algo que não é imagem), não pela extensão; falhou = `400 INVALID_PHOTO`.
4. Gera o `item_id`, converte as 3 fotos e sobe as 3 em paralelo.
5. Abre transação, insere `items` + 3 `item_photos` + evento `null → DISPONIVEL`.
6. Se o banco falhar, apaga as 3 fotos do Storage antes de responder `500`.

O frontend já manda as fotos comprimidas (roadmap, D4), então o caso comum fica bem abaixo de 1 MB por foto. A conversão no servidor existe para garantir o formato, não para economizar banda.

Cadastro de ONG segue o mesmo padrão: valida, sobe o documento, cria `users` + `ngo_profiles` na mesma transação e remove o arquivo se a transação falhar.

## Erros, testes e deploy

### Formato de erro

Toda resposta de erro tem o mesmo formato da spec (`INVALID_PHOTO_COUNT`), com `details` só em erro de validação. Erro inesperado vira `500 INTERNAL_ERROR` com mensagem genérica, e o stack vai só para o log.

```ts
// core/errors.ts
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

// resposta
{ "error": "VALIDATION_ERROR", "message": "Dados inválidos.", "details": [{ "path": "title", "message": "Mínimo de 3 caracteres" }] }
```

Mensagens em português, prontas para a UI exibir; o frontend decide o comportamento pelo `error`, nunca pelo texto.

### Testes

Testes de integração com `app.inject()` contra um Postgres de teste (Docker local ou um segundo projeto Supabase), com `TRUNCATE` entre suítes e Storage substituído por um fake em memória. Prioridade no MVP, nesta ordem:

1. Ciclo completo: publicar → curtir → escolher → mensagem → confirmar.
2. Cancelamento por cada lado devolve `DISPONIVEL`, limpa `selected_ngo_id` e grava 2 eventos.
3. Duas chamadas simultâneas de `select-ngo` com ONGs diferentes: uma `200`, outra `409`.
4. Trava de fotos: 0, 2, 4 fotos e um arquivo que não é imagem.
5. Acesso cruzado: outro doador, ONG não selecionada e ONG pendente recebem `403`/`404` em todas as rotas de item e chat.
6. Nova ONG selecionada não lê mensagens da negociação anterior.

### Deploy

- **Build:** `tsup src/server.ts` → `node dist/server.js`; `npm run migrate` roda os `.sql` pendentes antes do start, registrando em `schema_migrations`.
- **Render/Railway:** health check em `GET /health` (faz `SELECT 1`); `trustProxy: true` para o rate limit ver o IP real.
- **Logs:** logger `pino` do Fastify em JSON, com `request id`; nunca logar senha, token ou corpo de `multipart`.
- **Seed:** `npm run seed` cria o Admin a partir de `ADMIN_EMAIL`/`ADMIN_PASSWORD` e, com `SEED_DEMO=true`, as contas e itens de demo do roadmap.
- **CORS:** só a origem em `CORS_ORIGIN`; `localhost:5173` liberado apenas com `NODE_ENV=development`.

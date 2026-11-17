# Conecta Doações — API

API do MVP Conecta Doações: doadores publicam itens com 3 fotos, ONGs aprovadas da mesma cidade demonstram interesse, o doador escolhe uma ONG e os dois combinam a entrega por chat até a ONG confirmar o recebimento.

Node + Fastify 5 + TypeScript, com o Supabase usado só como Postgres e Storage (sem Supabase Auth). O contrato fica em [docs/specs/openapi.yaml](docs/specs/openapi.yaml), e o chat em tempo real em [Spec do Chat em Tempo Real — WebSocket](docs/specs/Spec%20do%20Chat%20em%20Tempo%20Real%20—%20WebSocket.md).

## Rodar localmente

Pré-requisitos: Node 22 ou mais novo, Docker e um projeto Supabase (usado só para o Storage em dev).

```bash
npm install
docker compose up -d                 # Postgres de dev (5434) e de teste (5433)
cp .env.example .env                 # preencha os valores (veja a tabela abaixo)
npm run storage:check                # cria os buckets no Supabase, se faltarem, e testa upload e leitura
npm run migrate
SEED_DEMO=true npm run seed          # Admin + contas e itens de demo
npm run dev                          # http://localhost:3333 — Swagger em /docs
```

No PowerShell, troque `SEED_DEMO=true npm run seed` por `$env:SEED_DEMO='true'; npm run seed`, ou ponha `SEED_DEMO=true` no `.env`.

### Contas de demo

Criadas pelo seed com `SEED_DEMO=true`:

| Perfil | E-mail | Senha |
| --- | --- | --- |
| Admin | valor de `ADMIN_EMAIL` | valor de `ADMIN_PASSWORD` |
| Doadora (6 itens publicados) | `doadora@demo.conectadoacoes.local` | `Demo1234` |
| ONG aprovada (já curtiu 1 item) | `ong.ativa@demo.conectadoacoes.local` | `Demo1234` |
| ONG em análise | `ong.pendente@demo.conectadoacoes.local` | `Demo1234` |

Todas ficam em São Paulo/SP. O seed é idempotente: rodar de novo não duplica nada.

## Variáveis de ambiente

Todas são lidas e validadas uma única vez em [src/core/env.ts](src/core/env.ts). Valor inválido derruba o boot com mensagem clara, em vez de falhar na primeira requisição.

| Variável | Obrigatória | Exemplo / default | Uso |
| --- | --- | --- | --- |
| `DATABASE_URL` | sim | `postgresql://postgres:postgres@localhost:5434/conecta` | Em produção, o pooler do Supabase (porta 6543) |
| `SUPABASE_URL` | sim | `https://<ref>.supabase.co` | Storage |
| `SUPABASE_SERVICE_ROLE_KEY` | sim | — | Storage; segredo, só no servidor |
| `JWT_SECRET` | sim | `openssl rand -base64 48` | Mínimo de 32 caracteres |
| `CORS_ORIGIN` | sim | `https://conectadoacoes.vercel.app` | Várias origens separadas por vírgula. Em dev, `localhost:5173` é liberado automaticamente |
| `JWT_EXPIRES_IN` | não | `7d` | Validade do token |
| `PORT` / `HOST` | não | `3333` / `0.0.0.0` | |
| `LOG_LEVEL` | não | `info` | |
| `TRUST_PROXY` | não | `false` | `true` atrás do proxy do Render/Railway, para o rate limit ver o IP real |
| `SWAGGER_ENABLED` | não | `false` | `/docs`; deixe desligado em produção |
| `RESEND_API_KEY` | em produção | `re_...` | Envio do e-mail de recuperação de senha. Sem ela (só fora de produção), o e-mail com o link sai no log |
| `EMAIL_FROM` | não | `Conecta Doações <nao-responda@seudominio.com.br>` | Remetente; precisa ser de um domínio verificado no Resend. O padrão `onboarding@resend.dev` só entrega para o e-mail dono da conta Resend |
| `APP_URL` | não | `https://conectadoacoes.vercel.app` | Frontend; o link do e-mail é `APP_URL/redefinir-senha?token=…` (padrão `http://localhost:5173`) |
| `STORAGE_BUCKET_ITEMS` / `STORAGE_BUCKET_DOCS` | não | `items` / `ngo-docs` | |
| `RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` | não | `120` / `10` | Por minuto: global por IP / `/auth/*` por IP |
| `ITEMS_RATE_LIMIT_MAX` / `MESSAGES_RATE_LIMIT_MAX` | não | `10` / `30` | Por minuto e por usuário: `POST /items` / envio de mensagem |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `SEED_DEMO` | só no seed | — | Lidas só por `npm run seed` |

## Scripts

| Script | Faz |
| --- | --- |
| `npm run dev` | API com reload |
| `npm run migrate` | Aplica as migrações pendentes de `migrations/` (registradas em `schema_migrations`) |
| `npm run seed` | Cria o Admin; com `SEED_DEMO=true`, também a demo |
| `npm run storage:check` | Confere os buckets (cria se faltarem) e testa upload, URL pública e URL assinada |
| `npm test` | Testes unitários em modo watch (sem banco) |
| `npm run test:int` | Integração + e2e + contrato contra o Postgres de teste (`docker compose up -d db-test`) |
| `npm run test:all` | Tudo, com cobertura |
| `npm run typecheck` / `npm run lint` | TypeScript estrito / ESLint, incluindo a regra de imports entre camadas |
| `npm run build` | Gera `dist/` com `tsup` |
| `npm run start:prod` | Migra e sobe `dist/server.js` (comando de produção) |

## Arquitetura

Um módulo por área do contrato (`auth`, `admin`, `items`, `interests`, `chats`, `health`), cada um em camadas fixas ([ADR-11](docs/adr/ADR-11-camadas.md)):

```text
routes → controller → service → repository → Postgres
  (dto: schemas Zod de entrada e saída, ao lado)
```

- **routes:** registra a rota, liga os DTOs e aplica os guards (`requireRole`, `requireActiveNgo`).
- **controller:** traduz HTTP para o service e converte a saída com `toXxxDto`.
- **service:** regras de negócio, permissões finas, transações e escolha do erro.
- **repository:** o único lugar com SQL.

O ESLint barra imports que pulam camadas.

Pontos que valem conhecer antes de mexer:

- **Toda rota nasce fechada.** O hook global de [src/core/auth.ts](src/core/auth.ts) exige JWT, exceto em rotas com `config: { public: true }`. Um teste e2e chama cada rota sem token e espera 401.
- **Transições de estado são atômicas.** `select-ngo`, `confirm-receipt` e `cancel` são um `UPDATE ... WHERE status = <esperado>`. Zero linhas afetadas significa conflito, e o service só então lê o item para escolher entre 404, 403 e 409. Toda transição grava um evento em `item_events`.
- **Erros saem por um lugar só.** O código lança `new AppError('CODIGO')` com um código de [src/core/errors/catalog.ts](src/core/errors/catalog.ts), e o handler global responde `{ error, message, details? }`.
- **Upload:** o multipart é lido em memória, o tipo é conferido pelos bytes e as fotos são convertidas para webp com `sharp` antes de subir. Se o banco falhar, os arquivos são apagados do Storage.
- **Chat:** as rotas REST são o contrato. O WebSocket em `/api/v1/chats/ws` só empurra eventos, e o polling com `?after=` continua como fallback.

## Testes

```bash
docker compose up -d db-test
npm run test:all
```

| Tipo | Onde | Banco | Storage |
| --- | --- | --- | --- |
| Unitário de service | `src/**/*.test.ts` | fake | fake |
| Integração de repository (corridas, transições) | `test/integration` | Postgres real | — |
| E2E com `app.inject()` e WebSocket | `test/e2e` | Postgres real | fake em memória |
| Contrato | `expectContract()` em cada resposta e2e | — | — |

O setup recria o schema do banco de teste (`DROP SCHEMA public`) antes de cada execução e se recusa a rodar se `DATABASE_URL` não contiver `_test`.

## Deploy (Render)

O [render.yaml](render.yaml) descreve o serviço: build com `npm ci --include=dev && npm run build`, start com `npm run start:prod` (migra e sobe) e health check em `/health/ready`.

1. No Supabase, use a connection string do **pooler** (porta 6543) em `DATABASE_URL` e rode `npm run storage:check` uma vez apontando para o projeto de produção.
2. Crie o serviço pelo Blueprint e preencha os segredos marcados com `sync: false`.
3. Depois do primeiro deploy, crie o Admin: no Shell do Render, `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed:prod`. Em produção, o seed recusa senha fraca.

Limites conhecidos desta versão:

- **Uma instância.** O rate limit e os eventos do chat ficam em memória. Para escalar, troque por Redis (opção `redis` do `@fastify/rate-limit` e uma implementação de `RealtimeBus`).
- **Upload:** até 3 × 5 MB por requisição passam pela API. Por isso a API roda em processo contínuo, e não em funções serverless da Vercel, que limitam o corpo a cerca de 4,5 MB.

## Problemas comuns

| Sintoma | Causa / solução |
| --- | --- |
| `Variáveis de ambiente inválidas` no boot | O `.env` não tem uma variável obrigatória ou ela está fora do formato. A mensagem diz qual |
| `port is already allocated` no `docker compose up` | Outro Postgres está na porta. O compose usa 5434 (dev) e 5433 (teste); mude em `docker-compose.yml` e no `.env` se precisar |
| Testes falham com "failed to find the current suite" | Rodou `npx vitest` direto num terminal aberto em `c:\` minúsculo (Windows). Use `npm test`, que passa pelo [scripts/vitest.mjs](scripts/vitest.mjs) |
| Upload falha com `Bucket not found` | Rode `npm run storage:check` |
| `GET /health/ready` responde 503 | O banco não respondeu em 2 s. Confira `DATABASE_URL` e se o container está de pé |

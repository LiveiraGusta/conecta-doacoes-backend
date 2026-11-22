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
| `CORS_ORIGIN` | sim | `https://app.seudominio.com.br` | Várias origens separadas por vírgula. Em dev, `localhost:5173` é liberado automaticamente. Em produção: só `https://host`, sem barra final, e nunca `*.vercel.app` / `*.onrender.com` (ADR-13; a API recusa subir) |
| `COOKIE_SECURE` | em produção | `false` / `true` | Cookie de sessão só por HTTPS. Obrigatório `true` em produção (a API recusa subir sem isso) |
| `COOKIE_DOMAIN` | não | vazio / `.seudominio.com.br` | Domínio do cookie. Vazio = só o host da API, que já funciona com `app.<dom>` + `api.<dom>`. Se preenchido, toda origem do `CORS_ORIGIN` precisa estar dentro dele |
| `JWT_EXPIRES_IN` | não | `7d` | Validade do token |
| `PORT` / `HOST` | não | `3333` / `0.0.0.0` | |
| `LOG_LEVEL` | não | `info` | |
| `LOG_FILE_DIR` | não | vazio / `logs` | Vazio: logs só no stdout. Com uma pasta, também grava `api.<data>.<n>.log` com rotação diária. Em produção no Render, deixe vazio (o disco é apagado a cada deploy) e use um *Log Stream* |
| `LOG_FILE_RETENTION` / `LOG_FILE_MAX_SIZE` | não | `14` / `20m` | Arquivos antigos guardados / tamanho que força a rotação |
| `TRUST_PROXY` | não | `false` | `true` atrás do proxy do Render/Railway, para o rate limit ver o IP real |
| `SWAGGER_ENABLED` | não | `false` | `/docs`; deixe desligado em produção |
| `BREVO_API_KEY` | esta ou `RESEND_API_KEY`, em produção | `xkeysib-...` | Envio dos e-mails (recuperação de senha e [notificações](#e-mails)) pelo Brevo (plano grátis, cerca de 300 por dia). **Não exige domínio**: basta verificar o remetente em *Senders*. Tem prioridade sobre o Resend. Sem nenhuma chave (só fora de produção), os e-mails saem no log |
| `RESEND_API_KEY` | esta ou `BREVO_API_KEY`, em produção | `re_...` | Alternativa ao Brevo; exige um domínio verificado no Resend para entregar a qualquer pessoa |
| `EMAIL_FROM` | com Brevo, sim | `Conecta Doações <seuemail@gmail.com>` | Remetente. No Brevo, o e-mail verificado em *Senders* (o padrão `onboarding@resend.dev` é recusado na subida). No Resend, um endereço de domínio verificado; o padrão só entrega para o e-mail dono da conta |
| `APP_URL` | não | `https://app.seudominio.com.br` | Frontend; base de todos os links dos e-mails, como `APP_URL/redefinir-senha?token=…` e `APP_URL/chats/<item>` (padrão `http://localhost:5173`). Em produção, com https e presente no `CORS_ORIGIN` |
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

Um módulo por área do contrato (`auth`, `admin`, `items`, `interests`, `chats`, `reports`, `profile`, `users`, `health`, além de `notifications`, que não tem rotas), cada um em camadas fixas ([ADR-11](docs/adr/ADR-11-camadas.md)):

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
- **E-mails:** os services só chamam `notifier.notify(evento)`; a busca dos destinatários e o envio acontecem em segundo plano e nunca mudam a resposta. Detalhes em [E-mails](#e-mails).

## E-mails

O provedor é escolhido na subida: **Brevo** (`BREVO_API_KEY`), senão **Resend** (`RESEND_API_KEY`), senão o e-mail só aparece no log (fora de produção). O código do envio está em [src/core/email.ts](src/core/email.ts); quem recebe cada e-mail e o texto ficam em [src/modules/notifications/](src/modules/notifications/).

| Quando | Quem recebe | Assunto | Onde dispara |
| --- | --- | --- | --- |
| Pedido de "Esqueci a senha" | A pessoa | Redefinição de senha | `password-reset.service.ts` |
| Senha redefinida pelo link ou trocada no perfil | A pessoa | Sua senha foi alterada | `password-reset.service.ts`, `profile.service.ts` |
| Doador cria a conta | Doador | Boas-vindas | `auth.service.ts` |
| ONG cria a conta | ONG e cada administrador | Cadastro recebido / Nova ONG para análise | `auth.service.ts` |
| ONG reenvia o documento | Cada administrador | Documento reenviado | `profile.service.ts` |
| Administrador aprova a ONG | ONG | ONG aprovada | `admin.service.ts` |
| Administrador rejeita a ONG | ONG (com o motivo) | Cadastro não aprovado | `admin.service.ts` |
| ONG demonstra interesse | Doador | Nova ONG interessada em "…" | `interests.service.ts` |
| Doador escolhe a ONG | ONG | Sua ONG foi escolhida para "…" | `interests.service.ts` |
| Negociação cancelada | A outra parte (com o motivo) | Negociação cancelada | `chats.service.ts` |
| ONG confirma o recebimento | Doador | Doação concluída | `chats.service.ts` |
| Denúncia aberta | Cada administrador | Nova denúncia sobre "…" | `reports.service.ts` |
| Conta excluída | A pessoa (endereço de antes da anonimização) | Conta excluída | `profile.service.ts` |

Regras:

- **Mensagem de chat não gera e-mail.** O app já avisa em tempo real, e o volume passaria do limite grátis do Brevo (cerca de 300 por dia).
- **Falha no envio não muda a resposta da API.** O erro vai para o log com o tipo do evento (`Falha ao enviar e-mail de notificação`). Cada destinatário é independente.
- **Conta excluída não recebe nada depois.** As buscas ignoram usuários com `deleted_at`.
- Todo texto vindo do usuário (nome, título, motivo) é escapado no HTML, e todo e-mail tem também a versão em texto puro.
- Ao desligar, a API espera os e-mails em andamento antes de fechar o banco.

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
| E-mails | `ctx.outbox` + `await ctx.flushEmails()` nos e2e; jornada completa em [test/e2e/notifications.test.ts](test/e2e/notifications.test.ts) | — | — |
| Contrato | `expectContract()` em cada resposta e2e | — | — |

O setup recria o schema do banco de teste (`DROP SCHEMA public`) antes de cada execução e se recusa a rodar se `DATABASE_URL` não contiver `_test`. O `.env.test` zera `BREVO_API_KEY` e `RESEND_API_KEY`: os testes nunca usam o provedor real, mesmo com chaves no `.env`.

## Deploy (Render)

O [render.yaml](render.yaml) descreve o serviço: build com `npm ci --include=dev && npm run build`, start com `npm run start:prod` (migra e sobe) e health check em `/health/ready`.

**Pré-requisito: domínio próprio**, com o front em `app.<domínio>` e a API em `api.<domínio>`. O cookie de sessão (`SameSite=Lax`) só vai nas requisições do front se os dois estiverem no mesmo site; `*.vercel.app` e `*.onrender.com` estão na Public Suffix List e contam como sites diferentes ([ADR-13](docs/adr/ADR-13-sessao-cookie.md)). Em produção a API confere isso no boot e recusa subir com a config errada.

1. No Supabase, use a connection string do **pooler** (porta 6543) em `DATABASE_URL` e rode `npm run storage:check` uma vez apontando para o projeto de produção.
2. Crie o serviço pelo Blueprint e preencha os segredos marcados com `sync: false`: `CORS_ORIGIN` e `APP_URL` com `https://app.<domínio>`; `COOKIE_DOMAIN` pode ficar vazio. `COOKIE_SECURE=true` já vem do Blueprint.
3. No Render, adicione o domínio personalizado `api.<domínio>` ao serviço e crie o registro DNS que ele indicar.
4. Depois do primeiro deploy, crie o Admin: no Shell do Render, `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed:prod`. Em produção, o seed recusa senha fraca.
5. Confira: `https://api.<domínio>/health/ready` responde `ok` e o login pelo front grava o cookie `cd_session` com `Secure`.

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

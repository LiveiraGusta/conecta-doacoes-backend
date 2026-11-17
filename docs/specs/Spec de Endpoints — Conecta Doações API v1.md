# Spec de Endpoints — Conecta Doações API v1

Nov 16, 2026 · @Liveira

## Convenções

Todas as rotas vivem em `/api/v1`, falam JSON (exceto as 2 rotas com upload, em `multipart/form-data`) e seguem as regras abaixo. Cada módulo só descreve o que é específico dele.

| Item | Regra |
| --- | --- |
| Base URL | `https://<api>/api/v1` |
| Autenticação | `Authorization: Bearer <jwt>` em toda rota marcada como privada |
| IDs | UUID v4 em string |
| Datas | ISO 8601 em UTC (`2026-11-16T17:10:00.000Z`) |
| Nomes de campo | `snake_case` no JSON, igual às colunas do banco |
| Textos | `trim` antes de validar; vazio depois do `trim` conta como ausente |
| Paginação | `?limit=` (1–50, default 30) e `?offset=` (≥ 0, default 0); resposta traz `total` sem limite |
| Rate limit | 10 req/min por IP em `/auth/*`; 120 req/min por usuário no resto |

### Formato de erro

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Dados inválidos.",
  "details": [{ "path": "email", "message": "E-mail inválido" }]
}
```

`error` é o código estável que o frontend usa para decidir o que fazer; `message` é texto em português pronto para exibir; `details` só aparece em `VALIDATION_ERROR`.

Erros que valem para qualquer rota e não se repetem nos módulos:

| Status | `error` | Quando |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Corpo, query ou params fora do schema |
| 401 | `UNAUTHORIZED` | Token ausente, inválido, expirado ou de usuário apagado |
| 403 | `FORBIDDEN` | Role errada ou usuário não é dono/participante |
| 403 | `NGO_NOT_APPROVED` | ONG pendente ou rejeitada em rota que exige ONG ativa |
| 404 | `NOT_FOUND` | Rota inexistente |
| 429 | `TOO_MANY_REQUESTS` | Rate limit estourado |
| 500 | `INTERNAL_ERROR` | Qualquer erro não previsto |

### Tipos compartilhados

Os módulos referenciam estes objetos pelo nome em vez de repetir os campos.

```ts
type Role = 'DONOR' | 'NGO' | 'ADMIN';
type NgoStatus = 'PENDENTE_APROVACAO' | 'ATIVO' | 'REJEITADO';
type Category = 'ROUPAS' | 'BRINQUEDOS' | 'ALIMENTOS' | 'LIVROS';
type ItemStatus = 'DISPONIVEL' | 'EM_PROGRESSO' | 'DOADO';   // CANCELADO só existe em item_events
type UF = 'AC' | 'AL' | /* ... */ 'TO';                        // 27 siglas

interface NgoProfile {
  id: string;
  cnpj: string;                 // sempre mascarado: 12.345.678/0001-99
  website: string | null;
  status: NgoStatus;
  rejection_reason: string | null;
}

interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  city: string;
  state: UF;
  ngo_profile?: NgoProfile;     // só quando role = 'NGO'
}

interface AuthResponse {
  token: string;
  user: User;
}
```

`document_url` nunca aparece em `NgoProfile` para a própria ONG nem para doadores; só as rotas `/admin` devolvem o documento, como URL assinada.

## Módulo 1 — Autenticação & Moderação

Seis rotas: quatro públicas ou do próprio usuário (`/auth`) e duas exclusivas do Admin (`/admin/ngos`). A única mudança de contrato em relação à spec do produto é que o cadastro de ONG não devolve mais `document_url`.

| # | Rota | Acesso |
| --- | --- | --- |
| 1.1 | `POST /auth/register/donor` | público |
| 1.2 | `POST /auth/register/ngo` | público |
| 1.3 | `POST /auth/login` | público |
| 1.4 | `GET /auth/me` *(nova)* | qualquer usuário logado |
| 1.5 | `GET /admin/ngos` | `ADMIN` |
| 1.6 | `PATCH /admin/ngos/:ngoProfileId/status` | `ADMIN` |

### 1.1 `POST /auth/register/donor`

Cria um doador e já devolve o token, sem confirmação de e-mail no MVP.

| Campo | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `name` | string | sim | 2–255 caracteres |
| `email` | string | sim | e-mail válido; gravado em minúsculas |
| `password` | string | sim | 8–72 caracteres, ao menos 1 letra e 1 número |
| `city` | string | sim | 2–100 caracteres, nome como na lista do IBGE |
| `state` | `UF` | sim | uma das 27 siglas |

**Resposta `201`:** `AuthResponse`, com `user.role = 'DONOR'` e sem `ngo_profile`.

| Status | `error` | Quando |
| --- | --- | --- |
| 409 | `EMAIL_TAKEN` | Já existe usuário com o e-mail |

O limite de 72 caracteres na senha é o máximo que o `bcrypt` considera; acima disso o resto seria ignorado em silêncio.

### 1.2 `POST /auth/register/ngo`

Cria o usuário ONG e o `ngo_profile` com status `PENDENTE_APROVACAO` na mesma transação. A ONG já recebe token e pode navegar, mas não pode curtir itens até ser aprovada.

Request em `multipart/form-data`:

| Campo | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `name` | texto | sim | Razão social ou nome fantasia, 2–255 |
| `email` | texto | sim | igual ao 1.1 |
| `password` | texto | sim | igual ao 1.1 |
| `city` | texto | sim | igual ao 1.1 |
| `state` | texto | sim | igual ao 1.1 |
| `cnpj` | texto | sim | 14 dígitos com ou sem máscara; dígitos verificadores válidos |
| `website` | texto | não | URL `http(s)://`, até 255 |
| `document` | arquivo | sim | 1 arquivo PDF, JPG, PNG ou WEBP, até 5 MB |

**Resposta `201`:**

```json
{
  "token": "eyJhbGciOi...",
  "user": {
    "id": "770e8400-e29b-41d4-a716-446655440111",
    "name": "ONG Salvadora",
    "email": "contato@ongsalvadora.org.br",
    "role": "NGO",
    "city": "São Paulo",
    "state": "SP",
    "ngo_profile": {
      "id": "880e8400-e29b-41d4-a716-446655440222",
      "cnpj": "12.345.678/0001-99",
      "website": "https://ongsalvadora.org.br",
      "status": "PENDENTE_APROVACAO",
      "rejection_reason": null
    }
  }
}
```

| Status | `error` | Quando |
| --- | --- | --- |
| 400 | `INVALID_DOCUMENT` | Documento ausente, mais de 1 arquivo, tipo não aceito ou acima de 5 MB |
| 409 | `EMAIL_TAKEN` | E-mail já cadastrado |
| 409 | `CNPJ_TAKEN` | CNPJ já cadastrado |

O tipo do documento é conferido pelos primeiros bytes do arquivo (`%PDF`, assinaturas de JPG/PNG/WEBP), não pela extensão nem pelo `Content-Type` enviado. Se a transação falhar depois do upload, o arquivo é removido do Storage.

### 1.3 `POST /auth/login`

| Campo | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `email` | string | sim | normalizado como no cadastro |
| `password` | string | sim | não vazio |

**Resposta `200`:** `AuthResponse`. Para ONG, `ngo_profile` vem com o status atual, inclusive `REJEITADO` com o motivo, para o frontend mostrar o banner certo.

| Status | `error` | Quando |
| --- | --- | --- |
| 401 | `INVALID_CREDENTIALS` | E-mail inexistente ou senha errada (mesma resposta para os dois) |

Quando o e-mail não existe, a API ainda roda um `bcrypt.compare` contra um hash fixo, para o tempo de resposta não revelar quais e-mails estão cadastrados.

### 1.4 `GET /auth/me` *(nova)*

Devolve o usuário do token, lido do banco na hora. O frontend chama no boot para restaurar a sessão e sempre que quiser saber se a ONG já foi aprovada.

**Resposta `200`:** `{ "user": User }`, sem novo token.

Sem erros específicos além do `401` geral.

### 1.5 `GET /admin/ngos`

Lista ONGs para moderação, mais antigas primeiro, para a fila andar em ordem de chegada.

| Query | Tipo | Default | Regra |
| --- | --- | --- | --- |
| `status` | `NgoStatus` | `PENDENTE_APROVACAO` | filtra por status |
| `limit` / `offset` | número | 30 / 0 | paginação padrão |

**Resposta `200`:** o formato da spec do produto, com `document_url` agora como URL assinada que expira em 10 minutos e `created_at` vindo de `users.created_at`.

```json
{
  "total": 1,
  "data": [
    {
      "ngo_profile_id": "880e8400-e29b-41d4-a716-446655440222",
      "user_id": "770e8400-e29b-41d4-a716-446655440111",
      "name": "ONG Salvadora",
      "email": "contato@ongsalvadora.org.br",
      "city": "São Paulo",
      "state": "SP",
      "cnpj": "12.345.678/0001-99",
      "website": "https://ongsalvadora.org.br",
      "document_url": "https://xxxx.supabase.co/storage/v1/object/sign/ngo-docs/...?token=...",
      "status": "PENDENTE_APROVACAO",
      "rejection_reason": null,
      "created_at": "2026-11-16T16:46:00.000Z"
    }
  ]
}
```

Sem erros específicos. Se a URL expirar com a tela aberta, o painel só precisa refazer a listagem.

### 1.6 `PATCH /admin/ngos/:ngoProfileId/status`

Aprova ou rejeita uma ONG. Pode ser chamada de novo para mudar a decisão (por exemplo, reativar uma ONG rejeitada por engano).

| Campo | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `status` | `'ATIVO' \| 'REJEITADO'` | sim | não aceita voltar para `PENDENTE_APROVACAO` |
| `rejection_reason` | string | se `REJEITADO` | 10–1.000 caracteres; ignorado e gravado como `null` se `ATIVO` |

**Resposta `200`:**

```json
{ "id": "880e8400-e29b-41d4-a716-446655440222", "status": "REJEITADO", "rejection_reason": "Documento ilegível. Envie o cartão CNPJ atualizado." }
```

| Status | `error` | Quando |
| --- | --- | --- |
| 404 | `NGO_NOT_FOUND` | `ngoProfileId` não existe |

Rejeitar uma ONG que está negociando um item não cancela a negociação: ela ainda pode cancelar, mas não pode confirmar recebimento nem curtir novos itens. Curtidas antigas continuam visíveis para o doador, mas o `select-ngo` recusa ONG que não está `ATIVO`.

## Módulo 2 — Vitrine & Doações

Documentado em arquivo próprio, no formato Swagger: [API v1 — Módulo 2: Vitrine & Doações (Items)](https://claude.ai/artifact/UEAQ2vCcVUjW3yKXU823es).

## Módulo 3 — Match Invertido

Documentado em arquivo próprio, no formato Swagger: [API v1 — Módulo 3: Match Invertido (Interests)](https://claude.ai/artifact/7HK7Kt8Ua6kDizGBdxF1Ws).

## Módulo 4 — Chat, Encerramento & Denúncias

Documentado em arquivo próprio, no formato Swagger: [API v1 — Módulo 4: Chat, Encerramento & Denúncias](https://claude.ai/artifact/Rf9pRj5SB6aVxMU1wiEviz).

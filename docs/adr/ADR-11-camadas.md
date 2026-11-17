# ADR-11: Camadas Route → Controller → Service → Repository, com DTOs Zod e sem classes Model

**Status:** Aceito (implementado no MVP V1.0)
**Data:** 2026-11-16
**Decisores:** time de backend (trilhas A e B do roadmap)
**Texto completo:** [Spec de Arquitetura em Camadas — Conecta Doações API (PDF)](../specs/Spec%20de%20Arquitetura%20em%20Camadas%20—%20Conecta%20Doações%20API.pdf)

## Contexto

A Spec do Backend separava cada módulo em `routes`, `schemas` e `service`, com o SQL dentro do service. Isso obrigava a ter Postgres de pé para testar qualquer regra de negócio. O contrato público já estava fechado no `openapi.yaml`, e escrever o Swagger à mão, separado do código, levaria a divergências em poucos dias.

## Decisão

Cada módulo tem cinco arquivos com papéis fixos:

| Camada | Faz | Não faz |
| --- | --- | --- |
| `routes` | Registra a rota, liga os DTOs, aplica os guards | Ler o corpo à mão, ter regra de negócio |
| `controller` | Extrai a entrada validada, chama **um** método do service, escolhe o status HTTP, converte a saída com `toDto` | Abrir transação, decidir permissão, tocar no banco |
| `service` | Regras, permissão fina, transações (`db.tx`), escolha do `AppError` | Conhecer `request`/`reply`, escrever SQL |
| `repository` | SQL parametrizado, um método por consulta | Decidir erro HTTP, chamar outro repository |
| `dto` | Schemas Zod de entrada e saída e funções `toXxxDto` | Regras que dependem do banco |

As entidades são tipos em `src/types.ts`, sem classes Model: a regra que importa, a máquina de estados, mora num `UPDATE ... WHERE status = ...` atômico, não em métodos de objeto. A injeção de dependência é feita por fábricas (`createXxxService(deps)`) montadas em `app.ts`, e nos testes as mesmas fábricas recebem fakes.

## Opções consideradas

| | A. Service com SQL | B. Camadas + classes Model | **C. Camadas + DTO Zod (escolhida)** |
| --- | --- | --- | --- |
| Arquivos por módulo | 3 | 6 | 5 + `types.ts` |
| Teste de regra sem banco | não | sim | sim |
| Fonte da validação | Zod | Zod + classe | só Zod |
| Swagger | à mão | à mão ou decorators | gerado dos DTOs |

## Consequências

**Ficou mais fácil:**
- Testar as regras em milissegundos. Cada código de erro de cada service tem um teste unitário com fakes.
- Manter validação, tipos, filtro de resposta e Swagger alinhados, já que saem do mesmo schema. O serializer descarta campos fora do DTO (`password_hash`, `document_url`).

**Ficou mais difícil:**
- Rotas simples, como `GET /auth/me`, passam por todas as camadas.
- A disciplina de imports. Mitigado por `no-restricted-imports` em `eslint.config.js`, que barrou duas violações reais durante a implementação.

**Diferenças da implementação em relação ao PDF:**
- **Tipos de leitura:** `ItemView`, `InterestedNgo` e `ChatSummary` foram para `src/types.ts`, porque um dto não pode importar do repository.
- **Cancelamento em dois comandos:** `cancelIfInProgress` trava a linha (`SELECT ... FOR UPDATE`) e depois faz o `UPDATE`, dentro da transação do service. O CTE da Spec do Backend devolvia `NULL` para a ONG anterior; ver a nota na Spec do Backend.

**A revisitar:**
- Depois do MVP, gerar o `openapi.yaml` a partir do código (`/docs/json`) em vez de mantê-lo à mão. Hoje o teste de contrato compara os dois.

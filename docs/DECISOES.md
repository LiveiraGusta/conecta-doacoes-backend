# Registro de decisões — Conecta Doações API

Decisões tomadas na implementação do MVP (V1.0), da V1.1 e da integração com o frontend.

**Como ler a coluna "Quem tomou":**

| Valor | Significado |
| --- | --- |
| **Usuário** | Escolha explícita do responsável pelo produto |
| **Claude (aprovado)** | Claude propôs e o usuário aprovou antes da implementação |
| **Claude** | Decisão técnica de Claude durante a implementação, relatada no fim da fase. Pode ser revista |
| **Spec** | Já estava definido nas specs e só foi seguido |

As decisões maiores têm ADR próprio em [`adr/`](adr/).

---

## Planejamento

| Fase | Decisão | Quem tomou | Consequência |
| --- | --- | --- | --- |
| Plano | Reconstruir o `001_schema.sql` a partir das specs, porque a spec do produto não estava no repositório | Usuário | O schema 001 é uma reconstrução. Os nomes de constraint foram fixados (`users_email_key`, `ngo_profiles_cnpj_key`, `item_interests_item_id_ngo_id_key`) para mapear o erro 23505 |
| Plano | O ADR-11 (camadas) prevalece sobre a Spec do Backend | Usuário | Estrutura routes → controller → service → repository + dto, com SQL só no repository. A Spec do Backend ganhou uma nota de atualização |
| Plano | O `openapi.yaml` vence em qualquer divergência de rota, payload, status ou erro | Usuário | Entraram `GET /items/:id`, `DELETE /items/:id/interest`, `reason` no cancel, `NGO_NOT_ACTIVE` no select-ngo e `city`/`state` opcionais no `POST /items` |
| Plano | Escopo do MVP: Swagger e testes de contrato dentro; Denúncias e Perfil fora | Usuário | Os dois módulos foram para a V1.1. A tabela `reports` foi criada já na migração 002 |
| Plano | Docker para os bancos de dev e de teste; Supabase Storage real em dev | Usuário | `docker-compose` com `db` e `db-test` (tmpfs). Os testes usam um Storage fake em memória |
| Plano | Código direto em `backend/` | Usuário | O papel do `api/` das specs fica na raiz de `backend/` |
| Plano | Trabalhar fase a fase, parando ao fim de cada uma para o ok | Usuário | Cada fase termina com typecheck, lint, testes e verificação no ambiente real |
| Plano | Escrever o contrato no `openapi.yaml` antes do código e validar toda resposta dos testes e2e contra ele | Claude (aprovado) | Os testes de contrato pegaram bugs reais, como um 202 saindo com corpo `null` |

## MVP (V1.0)

| Fase | Decisão | Quem tomou | Consequência |
| --- | --- | --- | --- |
| 0 | Stack: Node ≥ 22 (24 em dev), Fastify 5, TypeScript strict, Zod 4, postgres.js, Vitest e tsup | Claude (aprovado) | Versões verificadas entre si na instalação |
| 0 | Regra do ESLint `no-restricted-imports` para impor as camadas | Spec (ADR-11) | Um import que fura a camada quebra o lint. Os tipos de domínio compartilhados foram para `src/types.ts` |
| 0 | Banco de dev na porta **5434** (e não 5432) | Claude | A porta 5432 já era usada por outro projeto da máquina, que não foi tocado |
| 0 | Testes rodam pelo wrapper `scripts/vitest.mjs` | Claude | Corrige um problema do Vitest no Windows com a letra do drive em minúsculo (`c:`) |
| 1 | postgres.js com `prepare: false` | Claude | Compatível com o pooler do Supabase (porta 6543) em produção |
| 1 | Autenticação fechada por padrão: hook global; só rotas com `config.public` passam | Spec (ADR-11) | Toda rota nova exige token. Um teste percorre as rotas registradas e exige 401 sem token |
| 1 | O contexto do usuário (papel, cidade, status da ONG) é lido do banco a cada requisição | Spec (ADR-11) | Aprovar ou rejeitar uma ONG vale na hora, sem novo login. Custa uma query por requisição |
| 1 | Catálogo único de erros (`AppError(code)`) e um handler que traduz Zod, Postgres, multipart e rate limit | Spec (ADR-11) | Respostas de erro uniformes (`{ error, message, details? }`), sem detalhe interno vazando |
| 1 | Migrações com advisory lock, aplicadas no start de produção | Claude | Duas instâncias subindo juntas não aplicam a mesma migração duas vezes |
| 2 | Login com e-mail inexistente compara contra um hash fixo | Claude | O tempo de resposta não revela quais e-mails estão cadastrados |
| 2 | Documento da ONG em bucket privado, entregue ao Admin por URL assinada de 10 min | Spec | O documento nunca aparece em `/auth/me` nem para outros usuários |
| 2 | Senha `root` no `ADMIN_PASSWORD` de dev | Usuário | O seed só avisa sobre senha fraca fora de produção. Em produção ele recusa |
| 3 | Fotos convertidas para WEBP (1600 px, qualidade 80, sem metadados) e tipo conferido pelos bytes | Spec | Arquivo disfarçado de imagem é recusado e a localização (EXIF) é removida |
| 3 | Fotos sobem antes da transação e são apagadas se o banco falhar | Spec | Não sobra arquivo órfão no Storage quando o cadastro do item falha |
| 4 | Toda mudança de status do item é um `UPDATE` condicional; o diagnóstico do erro só roda quando nenhuma linha muda | Spec | Duas escolhas simultâneas de ONG: só uma vence (há teste de corrida). Cada transição grava um evento em `item_events` |
| 5 | **Chat em tempo real por WebSocket**, junto com o REST | Usuário | [ADR-12](adr/ADR-12-chat-websocket.md). O REST continua sendo o contrato e o WebSocket só empurra eventos |
| 5 | O token do WebSocket vai na primeira mensagem, não na URL | Usuário | O token não vaza para logs de acesso. O frontend envia `{type:'auth'}` em até 5 s |
| 5 | Barramento de eventos em memória (`RealtimeBus`) | Usuário | Suficiente para 1 instância. Escalar exige trocar por Redis (ou `LISTEN/NOTIFY` com conexão direta) |
| 5 | O SQL do `cancel` da spec foi dividido em travar e ler, depois atualizar | Claude | O CTE original devolvia `NULL` na ONG anterior. A Spec do Backend foi anotada |
| 5 | Mensagens gravadas com precisão de milissegundos | Claude | O polling com `?after=` não devolve de novo a última mensagem (JS tem ms, Postgres tem µs) |
| 5 | Mensagens do chat filtradas pelo par atual (doador e ONG escolhida) | Spec | Depois de um cancelamento, a nova ONG não lê a conversa anterior |
| 5 | Ao reiniciar, o servidor fecha os WebSockets com código 1001 | Claude | O cliente sabe que deve reconectar. Deploy sem sockets presos |
| 6 | Seed de demo com fotos geradas na hora (sem imagens no repositório) | Claude (aprovado) | `SEED_DEMO=true` cria doadora, ONG ativa, ONG pendente e 6 itens. A senha de demo é `Demo1234` |
| 6 | Deploy no Render com `migrate && start` e health check em `/health/ready` | Claude (aprovado) | O serviço só recebe tráfego quando o banco responde. O Swagger fica desligado em produção |

## V1.1

| Fase | Decisão | Quem tomou | Consequência |
| --- | --- | --- | --- |
| Plano | Escopo da V1.1: Perfil, Recuperação de senha, Denúncias e Mensagens não lidas | Usuário | O painel de métricas ficou de fora |
| Plano | Provedor de e-mail: **Resend** | Usuário | Envio pela API HTTP, sem SDK (sem dependência nova) |
| Plano | Commitar ao fim de cada fase só quando o usuário pedir | Usuário | O commit da fase A foi feito sem pedido. A partir da fase B, só sob pedido |
| A | Tokens emitidos antes da última troca de senha são recusados (`password_changed_at`) | Claude | Trocar ou redefinir a senha derruba todas as sessões. A comparação é em segundos, para o login logo depois da troca continuar valendo |
| A | Excluir conta = **anonimizar** (nome "Usuário removido", e-mail liberado) | Claude | O histórico (itens doados, conversas) continua íntegro para a outra parte, e o e-mail pode ser cadastrado de novo |
| A | Excluir a conta do doador apaga de vez os itens disponíveis e as fotos deles | Claude | Onde a spec só dizia "saem do feed". Itens doados ficam no histórico |
| A | Excluir a conta da ONG remove o perfil (libera o CNPJ) e as curtidas em itens abertos | Claude | A ONG pode se recadastrar com o mesmo CNPJ |
| A | Excluir conta é bloqueado com negociação em andamento (`409 HAS_ACTIVE_NEGOTIATIONS`) | Claude | O usuário precisa concluir ou cancelar antes |
| A | ONG rejeitada ou pendente reenvia o documento e volta para a fila; o arquivo antigo só é apagado depois do commit | Claude | Uma falha no meio não deixa a ONG sem documento |
| A | Troca de senha limitada a 5 tentativas por minuto, por usuário | Claude | Dificulta adivinhar a senha atual com um token roubado |
| B | Contrato da recuperação: `forgot` sempre 202; `reset` 204 ou `400 INVALID_RESET_TOKEN` | Claude (aprovado) | A API não revela quais e-mails existem |
| B | Token de 32 bytes, **só o hash SHA-256 no banco**, válido por 30 min, uso único; um link novo invalida os anteriores | Claude (aprovado) | Um vazamento da tabela não permite redefinir senhas |
| B | Pedidos repetidos em menos de 60 s não geram outro e-mail | Claude | Evita lotar a caixa de e-mail de alguém. A resposta continua 202 |
| B | O e-mail é enviado em segundo plano; uma falha no Resend só vai para o log | Claude | O tempo de resposta e o status não denunciam se a conta existe |
| B | Sem `RESEND_API_KEY` o e-mail sai no log; em produção a chave é **obrigatória** | Claude | A API não sobe em produção sem a chave, para a recuperação de senha não ficar quebrada sem ninguém perceber |
| B | Remetente de teste `onboarding@resend.dev`, sem domínio verificado por enquanto | Usuário | Só entrega para o e-mail dono da conta Resend. Verificar um domínio antes de ter usuários reais |
| B | Não implementar o redirecionamento de e-mails de dev (`EMAIL_REDIRECT_TO`) | Usuário | Foi proposto, e o usuário seguiu para a fase C sem ele. Contas de teste com e-mail fictício não recebem o link |
| B | Deploy só com a aplicação completa | Usuário | As variáveis de produção e o seed do Admin ficam para depois |
| C | Só quem participa da negociação denuncia, com as mesmas regras de acesso do chat; a denunciada é sempre a outra parte | Claude | Depois de um cancelamento, a ONG que saiu não denuncia mais. O frontend deve orientar a denunciar antes de cancelar |
| C | Uma denúncia **aberta** por usuário e item, garantida por índice único parcial no banco | Spec + Claude | Dois cliques simultâneos geram uma denúncia só. Depois de resolvida, dá para abrir outra |
| C | Resolver uma denúncia é idempotente e grava quem resolveu e quando (`resolved_by`, `resolved_at`) | Claude | Há auditoria da moderação. Esses campos não aparecem na resposta da API |
| C | O detalhe da denúncia traz todas as mensagens do item, sem o filtro por par | Spec | O Admin vê inclusive negociações anteriores, já canceladas |
| C | Acréscimos ao contrato: `409 CHAT_CLOSED` e `429` no report, `400` no detalhe | Claude | Nada quebra para o frontend: só códigos de resposta novos |
| C | Denúncias limitadas a 5 por minuto, por usuário | Claude | Evita spam na fila do Admin |
| D | Não lida = mensagem recebida da **outra parte da negociação atual** depois da última leitura | Claude | Depois de um cancelamento, mensagens da ONG anterior não contam para ninguém |
| D | Marcar como lida é explícito (`POST /chats/:itemId/read`), não um efeito do `GET` das mensagens | Claude | O `GET` continua sem efeito colateral (o polling não "lê" sem o usuário ver). O frontend chama o `read` com a sala aberta e visível |
| D | Marca até a última mensagem **recebida**, não até "agora" | Claude | Uma mensagem gravada no mesmo instante não some sem ter sido vista. A marcação nunca volta no tempo |
| D | Enviar uma mensagem marca a conversa como lida para quem enviou | Claude | Quem responde não fica com badge da conversa em que acabou de escrever |
| D | `unread_count` entra no `ChatSummary` e há `GET /chats/unread` para o badge | Claude | Acréscimos sem quebra: o frontend atual continua funcionando |
| D | Evento `unread.updated` em **todas** as conexões do usuário, sem `subscribe` (canal por usuário no `RealtimeBus`) | Claude | O badge atualiza fora da sala e entre abas. Custa uma consulta por evento e por conexão. Fecha o "a revisitar" do ADR-12 |
| D | Tabela `chat_reads` (migração 006), com uma linha por usuário e conversa | Claude | Leitura persistida no servidor: vale entre aparelhos |

## Integração com o frontend (fase 0)

Mudanças pedidas no planejamento do frontend React. O plano e o registro completo ficam no repositório do frontend (`docs/specs/plano-frontend.md` e `docs/DECISOES.md`). Cada sub-fase tem uma branch própria a partir da `develop`.

| Fase | Decisão | Quem tomou | Consequência |
| --- | --- | --- | --- |
| 0.1 | Sessão em cookie httpOnly `cd_session` emitido pelo backend, só cookie (Bearer removido); login e cadastro devolvem `{ user }` | Usuário | Ver o [ADR-13](adr/ADR-13-sessao-cookie.md). `AuthResponse` mudou no openapi. Os testes mandam `cookie` (`authHeader` e `sessionCookie` em `test/helpers/factories.ts`) |
| 0.1 | Produção no mesmo site: `app.<domínio>` + `api.<domínio>`, cookie `SameSite=Lax` | Usuário (após a revisão técnica) | Com domínios diferentes, o Safari bloquearia o cookie e o WebSocket ficaria sem sessão. Novas variáveis `COOKIE_SECURE` (obrigatória `true` em produção) e `COOKIE_DOMAIN` |
| 0.1 | Anti-CSRF: `X-Requested-With: XMLHttpRequest` obrigatório em POST, PUT, PATCH e DELETE, inclusive no login; sem ele, `403 CSRF_HEADER_MISSING` | Usuário | Código novo no catálogo. Nas rotas fechadas a checagem roda depois da autenticação (sem sessão continua 401). O `inject` dos testes já manda o header; `ctx.rawInject` testa a falta dele |
| 0.1 | `POST /auth/logout` pública e idempotente; atributos do cookie centralizados em `src/core/session-cookie.ts` | Claude (aprovado) | O navegador só apaga o cookie se o `clear` repetir os mesmos atributos |
| 0.1 | Trocar a senha reemite o cookie da sessão atual; excluir a conta apaga o cookie | Claude (aprovado) | O frontend não precisa logar de novo depois da troca. As outras sessões continuam caindo |
| 0.1 | `@fastify/cookie` registrado antes do rate limit; `@fastify/jwt` com `verify.onlyCookie` | Revisão | A chave de rate limit por usuário lê o cookie. Sem `onlyCookie`, o plugin daria prioridade ao header `Authorization` |
| 0.1 | CORS com `credentials: true`, `x-requested-with` liberado e `x-request-id` exposto | Revisão | O front cross-origin lê o id do erro. Lista de origens única (`allowedOrigins` em `src/core/env.ts`) para o CORS e o WebSocket |
| 0.1 | WebSocket autentica pelo cookie no handshake e confere o `Origin`; sai a mensagem `{type:"auth"}` e o timer de 5 s | Usuário | Spec do WebSocket e ADR-12 atualizados. Mensagens enviadas antes do `ready` esperam a autenticação |
| 0.1 | `Origin` ausente ou fora da lista fecha com **4403** (e não 4401) | Claude | 4401 faria o frontend tratar como sessão expirada e deslogar; 4403 indica "não reconectar" sem mexer na sessão. O plano dizia 4401 |
| 0.1 | Rota do WebSocket continua `public` para o hook global e valida dentro do handler | Revisão | Um 401 no upgrade chegaria ao navegador como 1006, sem motivo |
| 0.1 | Teste que fixa a lista exata de rotas públicas | Revisão | Um `public: true` acidental quebra o build |
| 0.1 | Swagger: esquema `cookieAuth` e um script no Swagger UI que adiciona o header anti-CSRF e envia o cookie | Claude | O "Try it out" continua funcionando: o login pelo Swagger grava o cookie |
| 0.1 | Ordem das fotos do item garantida por teste (`photos[0]` = 1ª foto enviada) | Revisão | O frontend permite reordenar as fotos e escolher a capa sem mudança no backend |
| 0.2 | Campo `notes` ("Observações do doador") no item: opcional, até 1000 caracteres, com constraint no banco (migração 007) | Usuário | Vem em `Item` e `ItemDetail` (chave sempre presente, `null` quando vazio) e não no `FeedItem`, porque o card não mostra |
| 0.2 | `notes` não entra na busca do feed (`search` continua em título e descrição) | Claude | A busca segue o contrato atual. Dá para incluir depois, se o produto pedir |
| 0.2 | Observações não aparecem para o visitante sem login | Usuário (plano) | A rota pública de detalhe (sub-fase 0.2b-3) usa um DTO sem `notes` |
| 0.2b-1 | Descrição (`bio`, até 500) para doador e ONG; ONG ganha telefone, Instagram, categorias aceitas e endereço (migração 008) | Usuário | `PATCH /profile` estendido. Doador que envia campo de ONG recebe `400` com um item de `details` por campo |
| 0.2b-1 | Telefone guardado só com dígitos e DDD (10 ou 11), aceitando máscara na entrada | Usuário | O front formata e monta o link do WhatsApp. Só números brasileiros |
| 0.2b-1 | Instagram guardado só como usuário, sem @ e em minúsculas; a entrada aceita `@ong` ou a URL do perfil | Usuário | Regex do Instagram (letras, números, ponto e `_`, até 30) na API e no banco |
| 0.2b-1 | Endereço da ONG é tudo ou nada (complemento opcional), com CEP de 8 dígitos; o autopreenchimento pelo ViaCEP fica no front | Usuário | Constraint `ngo_profiles_address_complete` no banco. Na API, `address` é um objeto (`null` apaga as 5 colunas) |
| 0.2b-1 | Endereço visível a usuários logados só quando a ONG estiver `ATIVO` | Usuário | Vale na rota `GET /users/:id` (0.2b-3). Nesta fase só gravamos; a própria ONG sempre vê o seu |
| 0.2b-1 | Preferências (`theme_color`, `theme_mode`, `show_donations`) em tabela própria; sem linha = padrões | Usuário | Vêm em `user.preferences` no `/auth/me`, no login e no cadastro (o tema aplica no boot sem chamada extra), e em `GET`/`PATCH /profile/preferences` |
| 0.2b-1 | `show_donations` só para doador; ONG e Admin recebem `400` no campo | Claude (aprovado) | Admin troca o tema, mas não tem página pessoal |
| 0.2b-1 | Colunas de avatar e banner ficam para a migração da 0.2b-2, e não na 008 como dizia o plano | Claude | Cada sub-fase traz a sua migração e os seus testes |
| 0.2b-1 | O teste de contrato aceita propriedades extras nas respostas (não pegou os campos novos antes do openapi) | Claude | Reforça o item do plano: os schemas das rotas públicas (0.2b-3) terão `additionalProperties: false` |
| 0.2b-1 | O seed de demonstração ganhou descrição, contato, endereço e categorias na ONG ativa, e `show_donations` na doadora | Claude | O frontend tem dados para a página pessoal. O seed não foi rodado de novo no banco de dev |

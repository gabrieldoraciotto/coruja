# Pauta Jurídica

Esteira de produção de conteúdo para o escritório da Dra. Sara Rocha (Direito Previdenciário).

A plataforma lê notícias jurídicas de feeds oficiais, faz uma triagem de relevância,
gera **pauta + roteiro + legenda** de cada vídeo (já dentro das regras de publicidade
da OAB) e encaixa os roteiros aprovados num **calendário editorial com cadência fixa** —
resolvendo o problema de "às vezes 5 vídeos por semana, às vezes 2".

## Como funciona (o fluxo)

```
Feeds RSS  ->  Notícia  ->  Triagem (IA)  ->  Roteiro (IA)  ->  Aprovação (Dra. Sara)  ->  Calendário
 (fontes)     (Article)    relevante?        (Draft)          humano no meio            (Slot)
```

O segredo da cadência estável: o calendário cria **slots** nos dias-alvo (ex.: seg/qua/sex).
Os roteiros aprovados entram numa fila e vão preenchendo os próximos slots vagos, em ordem.
Enquanto houver estoque aprovado na fila, a frequência nunca falha.

## Stack

- **Node.js** (Express, ES Modules)
- **Postgres** + **Prisma** (Railway)
- **node-cron** para a coleta diária automática
- **SDK da Anthropic** para triagem e roteiro

## Rodando localmente

```bash
npm install
cp .env.example .env          # preencha DATABASE_URL e ANTHROPIC_API_KEY
npm run db:generate           # gera o Prisma Client
npm run db:push               # cria as tabelas no banco
npm run db:seed               # cadastra as fontes iniciais
npm run dev                   # sobe o servidor
```

Depois, para testar o ciclo completo:

```bash
curl -X POST localhost:3333/articles/ingest   # coleta + triagem
curl localhost:3333/articles?status=relevante # ver notícias aprovadas na triagem
# gere um roteiro a partir de uma notícia:
curl -X POST localhost:3333/articles/SEU_ID_AQUI/generate
curl localhost:3333/drafts?status=rascunho     # ver roteiros
curl -X POST localhost:3333/drafts/SEU_ID/approve
curl -X POST localhost:3333/calendar/sync      # cria slots e agenda
curl localhost:3333/calendar                   # ver o calendário
```

## Deploy no Railway

1. Suba este repositório no GitHub.
2. No Railway: **New Project -> Deploy from GitHub repo**.
3. Adicione um **PostgreSQL** ao projeto (Railway cria a variável `DATABASE_URL`).
4. Em **Variables**, adicione `ANTHROPIC_API_KEY` (e, se quiser, `CADENCE_DAYS` etc.).
5. Em **Settings -> Deploy**, defina o start command:
   ```
   npm run db:generate && npm run db:push && npm run db:seed && npm start
   ```
   (depois do primeiro deploy, pode deixar só `npm run db:generate && npm start`).

## Endpoints principais

| Método | Rota | O que faz |
|--------|------|-----------|
| POST | `/articles/ingest` | Coleta os feeds e faz a triagem |
| GET | `/articles?status=relevante` | Lista notícias |
| POST | `/articles/:id/generate` | Gera roteiro (body: `{ "format": "reel" \| "carrossel" }`) |
| GET | `/drafts?status=rascunho` | Lista roteiros |
| PATCH | `/drafts/:id` | Edita o texto do roteiro |
| POST | `/drafts/:id/approve` | Aprova (entra na fila) |
| POST | `/calendar/sync` | Cria slots e agenda os aprovados |
| GET | `/calendar` | Mostra o calendário |
| GET / POST | `/sources` | Lista / cadastra fontes |

## Aviso de conformidade

Os roteiros são **minutas geradas por IA**. A revisão da Dra. Sara é obrigatória antes
de qualquer publicação — tanto pela exatidão jurídica quanto pelas regras de publicidade
da OAB (Provimento 205/2021 e CED).

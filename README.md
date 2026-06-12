# Coruja 🦉

**Redação automática de conteúdo para Instagram.** O Coruja acompanha as notícias do tema do seu canal, dá nota de relevância para cada uma com justificativa, escreve roteiros de reel e carrossel com verificação de qualidade, e organiza tudo num calendário editorial — com teleprompter embutido para gravar.

**Demo pública:** https://coruja-web-three.vercel.app — é um playground compartilhado: sinta-se em casa, os dados são limpos toda madrugada e há um teto diário de gerações.

Este repositório é o backend (API). O frontend vive em [`coruja-web`](https://github.com/gabrieldoraciotto/coruja-web).

## Como funciona

1. **Tema do canal.** Você diz sobre o que é o canal ("nutrição esportiva", "finanças pessoais"...). Tudo se molda a ele: uma fonte dinâmica do Google Notícias passa a buscar esse assunto, e os prompts de IA inteiros — triagem, roteirista, verificador — são reescritos em torno do tema. Trocar de tema limpa a mesa: notícias e fontes do tema anterior saem de cena (preservando o que já virou roteiro).
2. **Coleta e triagem.** Os feeds RSS são coletados sob demanda e todo dia às 07:00. Cada notícia recebe da IA uma nota de relevância (0–100) e uma justificativa de uma frase; acima do corte (60, configurável) ela entra em "Relevantes". A triagem roda num trabalhador de fundo que sobrevive a reinícios e respeita o limite de tokens/minuto do provedor.
3. **Roteiro.** Um clique transforma a notícia (ou uma pauta livre, ou uma das pautas universais sugeridas) em roteiro de reel ou carrossel, com gancho, corpo e legenda. Antes de criar, dá para pedir uma explicação do assunto — o fluxo "entender antes de gerar".
4. **Selo de qualidade.** Todo roteiro passa por uma revisão automática contra regras de conteúdo honesto: sem promessa de resultado/ganho/cura, sem fato ou fonte inventada, sem clickbait que o conteúdo não cumpre, e temas sensíveis orientam a procurar um profissional. Alertas viram sugestões; um clique gera a versão corrigida.
5. **Calendário e gravação.** Roteiros aprovados entram na fila e são agendados nos dias de publicação escolhidos. Reels abrem num teleprompter com velocidade ajustável; carrosséis viram cartões numerados com botão de copiar.

## Arquitetura

| Camada | Stack | Hospedagem |
| --- | --- | --- |
| API | Node.js + Express + Prisma | Railway |
| Banco | PostgreSQL | Railway |
| Frontend | Next.js (App Router) + Tailwind | Vercel ([`coruja-web`](https://github.com/gabrieldoraciotto/coruja-web)) |
| IA | Cliente compatível com a API da OpenAI — funciona com Groq, Gemini, OpenRouter, GitHub Models | Groq (free tier) na demo |

Dois modelos com papéis distintos: um pequeno e rápido para a triagem em volume (`TRIAGE_MODEL`) e um maior para escrever os roteiros (`WRITER_MODEL`). Como os limites do provedor são por modelo, a triagem drenando a fila nunca disputa cota com uma geração interativa.

## Rodando localmente

```bash
# Backend (este repositório)
npm install
cp .env.example .env   # preencha DATABASE_URL e AI_API_KEY
npx prisma db push     # cria as tabelas
npm start              # sobe em http://localhost:3333

# Frontend (repositório coruja-web)
npm install
NEXT_PUBLIC_API_URL=http://localhost:3333 npm run dev
```

As variáveis estão documentadas no [`.env.example`](./.env.example).

## Decisões de engenharia (o que este projeto ensina)

**A matemática do free tier manda no desenho.** O plano gratuito da IA limita tokens *por minuto*. A triagem por isso avalia notícias em **lotes de 8 por chamada** (o custo fixo do prompt dilui — ~3x mais notícias no mesmo teto), com espaçamento calculado entre chamadas e retry paciente para os 429 residuais.

**Alfândega entre o modelo e o banco.** Modelos pequenos entregam conteúdo certo em formato errado. Na fronteira, duas defesas: um **resgate estrutural** que pesca as notas da triagem mesmo quando o JSON vem com sintaxe quebrada (ancorado nos nomes dos campos, que o modelo sempre acerta), e a **normalização de tipos** que achata listas/objetos em texto antes de salvar (o roteirista adora devolver o script como lista de parágrafos).

**Trabalho de fundo que sobrevive a deploys.** A triagem roda num trabalhador em memória com trava de instância única, fila drenada em lotes e **retomada automática no boot** — um deploy no meio do serviço não deixa notícias órfãs. Itens que falham ficam para a rodada seguinte em vez de travar a esteira.

**Modo playground.** Para uma demo pública aberta: reset noturno às 04:00 (apaga roteiros, notícias, fontes e configurações; re-semeia o padrão — e a coleta das 07:00 acorda a demo abastecida) e teto diário de gerações com mensagem amigável ao esgotar. Sem cadastro, sem senha — e sem sustos na cota.

## Origem

O Coruja nasceu como fork generalizado de um sistema interno construído para um nicho editorial específico. A generalização transformou o nicho em configuração: o mesmo motor que cobria um assunto fixo hoje se adapta a qualquer tema em tempo de execução.

## Como foi construído

Em parceria entre humano e IA: o planejamento, a arquitetura e a fabricação dos arquivos foram conduzidos em conversa com o Claude; a aplicação, os deploys e os testes de reprodução rodaram via Claude Code, com conferência por hash a cada lote e bancada de reprodução para validar correções contra os casos reais que falharam — incluindo reprovar e iterar um lote antes do commit.

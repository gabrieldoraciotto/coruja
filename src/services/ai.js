import OpenAI from "openai";
import { config } from "../config.js";

// Cliente compatível com a API da OpenAI. Funciona com Gemini, Groq, OpenRouter
// e GitHub Models — basta trocar AI_BASE_URL e os modelos no .env (ver config.js).
const client = new OpenAI({
  apiKey: config.ai.apiKey,
  baseURL: config.ai.baseUrl,
});

// Pequeno retry para o caso de estourar o limite por minuto (erro 429) dos free tiers.
async function withRetry(fn, tentativas = 4) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status || err?.response?.status;
      if (status === 429 && i < tentativas - 1) {
        const espera = 3000 * (i + 1); // 3s, 6s, 9s — o limite do free tier é por MINUTO
        await new Promise((r) => setTimeout(r, espera));
        continue;
      }
      throw err;
    }
  }
}

function extractText(resp) {
  return resp.choices?.[0]?.message?.content || "";
}

// Parse JSON tolerante a quebras de linha cruas dentro de strings
function parseAiJson(text) {
  let clean = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch (_) {}
  let out = "";
  let inString = false;
  let prev = "";
  for (const ch of clean) {
    if (ch === '"' && prev !== "\\") inString = !inString;
    if (inString) {
      if (ch === "\n") { out += "\\n"; prev = ch; continue; }
      if (ch === "\r") { out += "\\r"; prev = ch; continue; }
      if (ch === "\t") { out += "\\t"; prev = ch; continue; }
    }
    out += ch;
    prev = ch;
  }
  return JSON.parse(out);
}

// A IA às vezes devolve um campo de texto como LISTA de parágrafos (ou até
// objeto aninhado), mesmo quando o prompt pede string — e o banco só aceita
// texto. Achata qualquer formato para texto plano antes de confiar.
function textoPlano(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(textoPlano).filter(Boolean).join("\n\n");
  if (typeof v === "object") return Object.values(v).map(textoPlano).filter(Boolean).join("\n\n");
  return String(v);
}

// ── 1. Triagem de relevância ──────────────────────────────────────────────
export async function triageArticle({ title, summary, nicho }) {
  const prompt = `Você faz a triagem de notícias para um canal que produz conteúdo educativo no Instagram sobre: ${nicho}.

Avalie a notícia abaixo e responda APENAS com um JSON, sem texto antes ou depois, no formato:
{"score": <0-100>, "reason": "<uma frase curta>"}

Critérios de pontuação alta (score alto):
- Relação direta com o tema do canal (${nicho}) e efeito prático para o público.
- Novidades, mudanças, lançamentos ou decisões que esse público precise saber.
- Assunto que rende um bom vídeo curto ou carrossel educativo.

Critérios de pontuação baixa (score baixo):
- Assuntos sem relação com o tema do canal.
- Notícia institucional ou burocrática, sem efeito prático para o público.

NOTÍCIA:
Título: ${title}
Resumo: ${summary || "(sem resumo)"}`;

  const resp = await withRetry(() =>
    client.chat.completions.create({
      model: config.ai.triageModel,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const text = extractText(resp);
  try {
    const parsed = parseAiJson(text);
    return {
      score: Math.max(0, Math.min(100, parseInt(parsed.score, 10) || 0)),
      reason: parsed.reason || "",
    };
  } catch {
    return { score: 0, reason: "Falha ao interpretar a triagem — revisar manualmente." };
  }
}

// Triagem em LOTE: avalia várias notícias numa única chamada. O custo fixo do
// prompt é compartilhado, então o limite de tokens/minuto do free tier rende
// ~3x mais notícias do que uma chamada por notícia. Itens que voltarem sem
// nota (ou se o JSON vier malformado) simplesmente ficam para a próxima
// rodada — o chamador trata o vazio.
export async function triageArticlesBatch({ items, nicho }) {
  // Manchetes vêm cheias de aspas ('Não é só treino e dieta', diz fulano) e o
  // modelo pequeno as ecoa sem escapar, quebrando o JSON. Higieniza antes.
  const limpo = (t) => String(t || "").replace(/["'\u201C\u201D\u2018\u2019]/g, "");
  const lista = items
    .map((it, i) => `${i + 1}. Título: ${limpo(it.title)}\n   Resumo: ${limpo(it.summary) || "(sem resumo)"}`)
    .join("\n");

  const prompt = `Você faz a triagem de notícias para um canal que produz conteúdo educativo no Instagram sobre: ${nicho}.

Avalie CADA notícia da lista e responda APENAS com um JSON, sem texto antes ou depois, no formato:
{"resultados":[{"n":1,"score":<0-100>,"reason":"<uma frase curta>"},{"n":2,"score":...}]}
Inclua exatamente um item por notícia, com "n" igual ao número dela na lista. Não use aspas dentro de "reason".

Critérios de pontuação alta (score alto):
- Relação direta com o tema do canal (${nicho}) e efeito prático para o público.
- Novidades, mudanças, lançamentos ou decisões que esse público precise saber.
- Assunto que rende um bom vídeo curto ou carrossel educativo.

Critérios de pontuação baixa (score baixo):
- Assuntos sem relação com o tema do canal.
- Notícia institucional ou burocrática, sem efeito prático para o público.

NOTÍCIAS:
${lista}`;

  const resp = await withRetry(() =>
    client.chat.completions.create({
      model: config.ai.triageModel,
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const notas = new Map();
  const text = extractText(resp);
  let resultados = [];
  try {
    resultados = parseAiJson(text).resultados || [];
  } catch {
    // O modelo 8b frequentemente entrega as notas certas com sintaxe quebrada
    // (aspas de abertura faltando, escapes embaralhados). Em vez de jogar o
    // conteúdo fora, o resgate pesca os trios pela ESTRUTURA — os nomes dos
    // campos, que o modelo sempre acerta — ignorando a sintaxe ao redor.
    resultados = resgatarNotas(text);
    if (resultados.length) {
      console.log(`[triagem] JSON malformado — resgate estrutural recuperou ${resultados.length} nota(s).`);
    }
  }
  for (const r of resultados) {
    const item = items[parseInt(r.n, 10) - 1];
    if (!item) continue;
    notas.set(item.id, {
      score: Math.max(0, Math.min(100, parseInt(r.score, 10) || 0)),
      reason: String(r.reason || "").trim(),
    });
  }
  return notas;
}

// Pesca {n, score, reason} de um texto com JSON quebrado. Âncora nos nomes
// dos campos (na ordem pedida no prompt) e lê o reason até a próxima aspa,
// chave ou quebra de linha — tolera aspas de abertura ausentes.
function resgatarNotas(text) {
  const out = [];
  const re = /"n"\s*:\s*(\d+)\s*,\s*"score"\s*:\s*(\d+)\s*,\s*"reason"\s*:\s*"?([^"}\n]*)/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({ n: parseInt(m[1], 10), score: parseInt(m[2], 10), reason: m[3] });
  }
  return out;
}

// ── 2. Geração de roteiro ─────────────────────────────────────────────────
const REGRAS_CONTEUDO = `REGRAS OBRIGATÓRIAS DE CONTEÚDO HONESTO. NÃO PODEM SER VIOLADAS:
- Tom educativo e informativo. Nunca prometer resultado, ganho ou cura.
- NÃO inventar fatos, números, estatísticas, fontes ou citações. Sem certeza, falar de forma genérica.
- Sem clickbait enganoso: o que o gancho promete, o conteúdo precisa entregar.
- Em temas sensíveis (saúde, jurídico, financeiro), nada de conselho individualizado — orientar a procurar um profissional da área.
- Linguagem acessível ao público leigo.`;

// Alvos de duração do vídeo. Cada opção calibra o tamanho do roteiro.
const DURACOES = {
  curto: { label: "curto (~30 segundos)", segundos: 30, blocos: "3 a 4", cartoes: "4 a 5" },
  medio: { label: "médio (~60 segundos)", segundos: 60, blocos: "5 a 6", cartoes: "5 a 7" },
  longo: { label: "longo (~90 segundos)", segundos: 90, blocos: "7 a 9", cartoes: "7 a 9" },
};

function buildFormatoDuracao(format, duration) {
  const dur = DURACOES[duration] || DURACOES.medio;
  if (format === "carrossel") {
    return `Formato: CARROSSEL de Instagram com ${dur.cartoes} cartões (duração-alvo ${dur.label}). No campo "script", escreva o conteúdo de cada cartão separado por "---", começando pelo cartão de capa. Calibre a quantidade de texto para caber bem em ${dur.cartoes} cartões.`;
  }
  return `Formato: REEL / vídeo curto, com duração-alvo de aproximadamente ${dur.segundos} segundos de fala (vídeo ${dur.label}). No campo "script", escreva a fala em ${dur.blocos} blocos curtos, como o apresentador falaria para a câmera, ajustando a quantidade de texto para caber nesse tempo de vídeo.`;
}

// Monta o bloco de "origem" do roteiro nos prompts: notícia (quando vem de uma
// matéria) ou tema livre (pauta própria, sem notícia).
function buildOrigem({ title, summary, link, topic }) {
  if (topic) {
    return `TEMA (definido pelo criador, sem notícia de origem):
${topic}

IMPORTANTE: trate o tema de forma geral e educativa. NÃO invente números, estatísticas, fontes, percentuais, prazos, valores ou datas específicas. Se algo depender de dado exato, fale de forma genérica.`;
  }
  return `NOTÍCIA:
Título: ${title}
Resumo: ${summary || "(sem resumo)"}
Fonte: ${link}`;
}

// Gera um roteiro educativo a partir de um TEMA livre (pauta própria), sem
// notícia de origem. Mesma estrutura de saída do generateScript.
export async function generateFromTopic({ topic, nicho, format = "reel", duration = "medio" }) {
  const formatoInstrucao = buildFormatoDuracao(format, duration);

  const prompt = `Você é roteirista de um canal de conteúdo educativo no Instagram sobre: ${nicho}. O criador do canal quer um roteiro educativo sobre o tema indicado abaixo.

${REGRAS_CONTEUDO}

${formatoInstrucao}

Responda APENAS com um JSON, sem texto antes ou depois:
{
  "hook": "<frase de abertura que prende a atenção, sem clickbait enganoso>",
  "script": "<roteiro completo no formato indicado>",
  "caption": "<legenda do post, educativa, com 3 a 5 hashtags relevantes ao final>"
}

Regras de conteúdo (IMPORTANTES):
- Trate o tema de forma GERAL e educativa. NÃO invente números, estatísticas, fontes, percentuais, prazos, valores ou datas específicas. Se algo depender de dado exato, fale de forma genérica.
- Não prometa resultado nem ganho garantido.
- Respeite a duração-alvo indicada acima.
- Português do Brasil, claro e humano.

${buildOrigem({ topic })}`;

  const resp = await withRetry(() =>
    client.chat.completions.create({
      model: config.ai.writerModel,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const text = extractText(resp);
  const parsed = parseAiJson(text);
  return {
    hook: textoPlano(parsed.hook),
    script: textoPlano(parsed.script),
    caption: textoPlano(parsed.caption),
  };
}

export async function generateScript({
  title,
  summary,
  link,
  nicho,
  format = "reel",
  duration = "medio",
}) {
  const formatoInstrucao = buildFormatoDuracao(format, duration);

  const prompt = `Você é roteirista de um canal de conteúdo educativo no Instagram sobre: ${nicho}. A partir da notícia abaixo, escreva um roteiro educativo.

${REGRAS_CONTEUDO}

${formatoInstrucao}

Responda APENAS com um JSON, sem texto antes ou depois:
{
  "hook": "<frase de abertura que prende a atenção, sem clickbait enganoso>",
  "script": "<roteiro completo no formato indicado>",
  "caption": "<legenda do post, educativa, com 3 a 5 hashtags relevantes ao final>"
}

Regras de conteúdo:
- Base-se SOMENTE no que a notícia diz. Não invente números, estatísticas ou fontes que não estejam no texto.
- Respeite a duração-alvo indicada acima: o tamanho do roteiro deve ser coerente com o tempo de vídeo pedido.
- Se a notícia for vaga, mantenha o roteiro em termos gerais e oriente o público a confirmar com um profissional.
- Português do Brasil, claro e humano.

NOTÍCIA:
Título: ${title}
Resumo: ${summary || "(sem resumo)"}
Fonte: ${link}`;

  const resp = await withRetry(() =>
    client.chat.completions.create({
      model: config.ai.writerModel,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const text = extractText(resp);
  const parsed = parseAiJson(text);
  return {
    hook: textoPlano(parsed.hook),
    script: textoPlano(parsed.script),
    caption: textoPlano(parsed.caption),
  };
}

// ── 3. Selo de qualidade do conteúdo ──────────────────────────────────────
// Relê o roteiro à luz das regras de conteúdo honesto e aponta possíveis
// problemas. É um APOIO — a palavra final é sempre do criador.
// (Nome da função preservado do projeto-mãe por compatibilidade de rotas.)
export async function checkOAB({ hook, script, caption, nicho }) {
  const prompt = `Você é revisor de qualidade de conteúdo. Analise o post de Instagram de um canal sobre ${nicho} e diga se ele respeita as regras.

${REGRAS_CONTEUDO}

Procure por qualquer trecho que possa violar as regras: promessa ou garantia de resultado, ganho ou cura; fato, número, estatística ou fonte que pareça inventado; clickbait que o conteúdo não cumpre; conselho individualizado em tema sensível (saúde, jurídico, financeiro) sem orientar a procurar um profissional.

Responda APENAS com um JSON, sem texto antes ou depois:
{
  "conforme": <true se NÃO encontrou nenhum problema, false caso contrário>,
  "alertas": [
    { "problema": "<descreva o trecho ou a questão, citando o que está escrito>", "sugestao": "<como ajustar, em uma frase>" }
  ]
}

Se estiver tudo certo, devolva "conforme": true e "alertas": []. Seja criterioso, mas não invente problema onde não há: conteúdo educativo, honesto e em tom geral é permitido.

CONTEÚDO:
Gancho: ${hook}
Roteiro: ${script}
Legenda: ${caption}`;

  const resp = await withRetry(() =>
    client.chat.completions.create({
      model: config.ai.writerModel,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const text = extractText(resp);
  const parsed = parseAiJson(text);
  const alertas = (Array.isArray(parsed.alertas) ? parsed.alertas : [])
    .filter((a) => a && (a.problema || a.sugestao))
    .map((a) => ({ problema: String(a.problema || ""), sugestao: String(a.sugestao || "") }));

  return {
    // Só é "conforme" se a IA disse que sim E não listou nenhum alerta.
    conforme: parsed.conforme === true && alertas.length === 0,
    alertas,
  };
}

// Roda o selo de qualidade e devolve os campos já no formato para salvar no
// roteiro: oabConforme (bool) e oabAlertas (JSON em texto) — nomes de coluna
// herdados do projeto-mãe.
export async function evaluateOab({ hook, script, caption, nicho }) {
  const res = await checkOAB({ hook, script, caption, nicho });
  return {
    oabConforme: res.conforme,
    oabAlertas: JSON.stringify(res.alertas || []),
  };
}

// ── 4. Versão corrigida (ajusta os pontos do selo de qualidade) ────────────
// Reescreve o roteiro corrigindo os alertas da verificação, mantendo tema,
// formato e duração aproximada. Devolve { hook, script, caption }.
export async function generateCorrected({
  title,
  summary,
  link,
  nicho,
  topic = "",
  format = "reel",
  hook = "",
  script = "",
  caption = "",
  alertas = [],
}) {
  const listaAlertas = (Array.isArray(alertas) ? alertas : [])
    .map((a, i) => `${i + 1}. ${a.problema}${a.sugestao ? ` (sugestão: ${a.sugestao})` : ""}`)
    .join("\n");

  const prompt = `Você é roteirista de um canal de conteúdo educativo no Instagram sobre: ${nicho}. Abaixo está um roteiro que apresentou possíveis problemas na verificação de qualidade. Reescreva o roteiro CORRIGINDO esses pontos, mantendo o mesmo tema, o mesmo formato e a duração aproximada.

${REGRAS_CONTEUDO}

PONTOS A CORRIGIR (apontados na verificação):
${listaAlertas || "(nenhum ponto específico — apenas garanta total conformidade com as regras acima)"}

Responda APENAS com um JSON, sem texto antes ou depois:
{
  "hook": "<gancho corrigido>",
  "script": "<roteiro corrigido, no mesmo formato do original>",
  "caption": "<legenda corrigida, com 3 a 5 hashtags ao final>"
}

Regras de conteúdo:
- Corrija os pontos apontados sem inventar fatos novos. Não acrescente números, estatísticas ou fontes que não estavam no original.
- Mantenha o conteúdo educativo e em português do Brasil, claro e humano.

${buildOrigem({ title, summary, link, topic })}

ROTEIRO ATUAL (a corrigir):
Gancho: ${hook}
Roteiro: ${script}
Legenda: ${caption}`;

  const resp = await withRetry(() =>
    client.chat.completions.create({
      model: config.ai.writerModel,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const text = extractText(resp);
  const parsed = parseAiJson(text);
  return {
    hook: textoPlano(parsed.hook) || hook,
    script: textoPlano(parsed.script) || script,
    caption: textoPlano(parsed.caption) || caption,
  };
}

// ── 5. Regeneração de UMA parte do roteiro ────────────────────────────────
// Reescreve só o gancho, só o roteiro (com duração) ou só a legenda, mantendo
// coerência com as outras partes (que vêm no parâmetro). Não salva nada e não
// roda o selo — só devolve o novo texto da parte pedida: { hook } | { script } |
// { caption }. O selo de qualidade roda quando a edição é salva.
export async function regeneratePart({
  part,
  nicho,
  title,
  summary,
  link,
  topic = "",
  format = "reel",
  duration = "medio",
  hook = "",
  script = "",
  caption = "",
}) {
  const parte = ["hook", "script", "caption"].includes(part) ? part : "script";

  let campo;
  let instrucao;
  if (parte === "hook") {
    campo = "hook";
    instrucao =
      "Reescreva APENAS o GANCHO: uma frase de abertura que prende a atenção, sem clickbait enganoso. Mantenha coerência com o roteiro e a legenda atuais. NÃO reescreva o roteiro nem a legenda.";
  } else if (parte === "caption") {
    campo = "caption";
    instrucao =
      "Reescreva APENAS a LEGENDA do post: educativa, com 3 a 5 hashtags relevantes ao final. Mantenha coerência com o gancho e o roteiro atuais. NÃO reescreva o gancho nem o roteiro.";
  } else {
    campo = "script";
    instrucao = `Reescreva APENAS o ROTEIRO (o corpo do conteúdo). ${buildFormatoDuracao(
      format,
      duration
    )} Mantenha coerência com o gancho e a legenda atuais. NÃO reescreva o gancho nem a legenda.`;
  }

  const prompt = `Você é roteirista de um canal de conteúdo educativo no Instagram sobre: ${nicho}. ${instrucao}

${REGRAS_CONTEUDO}

Responda APENAS com um JSON, sem texto antes ou depois:
{ "${campo}": "<novo conteúdo>" }

Regras de conteúdo:
- Base-se SOMENTE na origem indicada. Não invente números, estatísticas ou fontes que não estejam na origem.
- Português do Brasil, claro e humano.

${buildOrigem({ title, summary, link, topic })}

CONTEÚDO ATUAL (para manter coerência):
Gancho: ${hook}
Roteiro: ${script}
Legenda: ${caption}`;

  const resp = await withRetry(() =>
    client.chat.completions.create({
      model: config.ai.writerModel,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const text = extractText(resp);
  const parsed = parseAiJson(text);
  const valor = textoPlano(parsed[campo]);
  if (!valor.trim()) {
    throw new Error("resposta vazia da IA");
  }
  return { [campo]: valor };
}

// ── Explicação de um tema (para o criador ler antes de gerar) ──────────────
// Não é roteiro: é um resumo educativo do assunto, para o criador decidir se
// vale virar conteúdo. Mantém a trava anti-invenção (geral, sem dado inventado).
export async function explainTopic({ topic, nicho }) {
  const prompt = `Você é assistente de um canal de conteúdo educativo sobre: ${nicho}. Explique, de forma clara e educativa, PARA O CRIADOR DO CANAL (que vai decidir se o assunto vale virar conteúdo), o seguinte tema:

"${topic}"

Escreva de 2 a 4 parágrafos curtos cobrindo: o que é, o que acontece / como funciona, e por que é relevante para o público do canal.

Regras:
- Trate o assunto de forma GERAL. NÃO invente números, estatísticas, fontes, percentuais, prazos, valores ou datas específicas. Se algo depender de dado exato, fale de forma genérica.
- Português do Brasil, claro e direto. Isto NÃO é um roteiro de post — é uma explicação para o criador entender o assunto antes de decidir.
- Responda apenas com o texto da explicação, sem título e sem marcadores.`;

  const resp = await withRetry(() =>
    client.chat.completions.create({
      model: config.ai.writerModel,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    })
  );
  return { explanation: extractText(resp).trim() };
}


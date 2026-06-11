import OpenAI from "openai";
import { config } from "../config.js";

// Cliente compatível com a API da OpenAI. Funciona com Gemini, Groq, OpenRouter
// e GitHub Models — basta trocar AI_BASE_URL e os modelos no .env (ver config.js).
const client = new OpenAI({
  apiKey: config.ai.apiKey,
  baseURL: config.ai.baseUrl,
});

// Pequeno retry para o caso de estourar o limite por minuto (erro 429) dos free tiers.
async function withRetry(fn, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status || err?.response?.status;
      if (status === 429 && i < tentativas - 1) {
        const espera = 2000 * (i + 1); // 2s, 4s, ...
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

// ── 1. Triagem de relevância ──────────────────────────────────────────────
export async function triageArticle({ title, summary }) {
  const prompt = `Você faz a triagem de notícias para uma advogada de DIREITO PREVIDENCIÁRIO que produz conteúdo educativo no Instagram.

Avalie a notícia abaixo e responda APENAS com um JSON, sem texto antes ou depois, no formato:
{"score": <0-100>, "reason": "<uma frase curta>"}

Critérios de pontuação alta (score alto):
- Mudanças em leis previdenciárias, INSS, aposentadoria, benefícios (auxílio-doença, BPC/LOAS, pensão, etc.).
- Teses, súmulas ou decisões do STF/STJ/TNU que afetem segurados.
- Novas Instruções Normativas do INSS, regras de transição da EC 103/2019.
- Qualquer coisa que um segurado comum precise saber e que renda um bom vídeo curto.

Critérios de pontuação baixa (score baixo):
- Assuntos sem relação com previdência (penal, tributário puro, eleitoral, etc.).
- Notícia institucional sem efeito prático para o segurado.

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

// ── 2. Geração de roteiro ─────────────────────────────────────────────────
const REGRAS_OAB = `REGRAS OBRIGATÓRIAS DE PUBLICIDADE DA OAB (Provimento 205/2021 e CED). NÃO PODEM SER VIOLADAS:
- Tom estritamente educativo e informativo. Nunca prometer resultado nem captar clientela.
- Enquadramento em terceira pessoa / caso hipotético. NUNCA "entre em contato", "agende sua consulta", "fale comigo", "me chame no direct" ou qualquer chamada para ação de contato.
- Proibido mercantilizar a advocacia, anunciar valores, sugerir urgência comercial ou se autopromover ("melhor advogada", "especialista nº 1", etc.).
- Linguagem acessível ao leigo, sem prometer que a pessoa "tem direito" — explicar que cada caso depende de análise.
- Pode orientar o público a "buscar orientação de um advogado de confiança", de forma genérica, sem direcionar a si mesma.`;

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
  return `Formato: REEL / vídeo curto, com duração-alvo de aproximadamente ${dur.segundos} segundos de fala (vídeo ${dur.label}). No campo "script", escreva a fala em ${dur.blocos} blocos curtos, como a Dra. Sara falaria para a câmera, ajustando a quantidade de texto para caber nesse tempo de vídeo.`;
}

// Monta o bloco de "origem" do roteiro nos prompts: notícia (quando vem de uma
// matéria) ou tema livre (pauta própria, sem notícia).
function buildOrigem({ title, summary, link, topic }) {
  if (topic) {
    return `TEMA (definido pela advogada, sem notícia de origem):
${topic}

IMPORTANTE: trate o tema de forma geral e educativa. NÃO invente números de tema repetitivo, súmula, número de processo, percentuais, prazos, valores ou datas específicas. Se algo depender de número exato, fale de forma genérica e oriente a confirmar com um profissional.`;
  }
  return `NOTÍCIA:
Título: ${title}
Resumo: ${summary || "(sem resumo)"}
Fonte: ${link}`;
}

// Gera um roteiro educativo a partir de um TEMA livre (pauta própria), sem
// notícia de origem. Mesma estrutura de saída do generateScript.
export async function generateFromTopic({ topic, format = "reel", duration = "medio" }) {
  const formatoInstrucao = buildFormatoDuracao(format, duration);

  const prompt = `Você é roteirista de conteúdo jurídico para uma advogada de DIREITO PREVIDENCIÁRIO no Brasil. A advogada quer um roteiro educativo sobre o tema indicado abaixo.

${REGRAS_OAB}

${formatoInstrucao}

Responda APENAS com um JSON, sem texto antes ou depois:
{
  "hook": "<frase de abertura que prende a atenção, sem clickbait enganoso>",
  "script": "<roteiro completo no formato indicado>",
  "caption": "<legenda do post, educativa, com 3 a 5 hashtags relevantes ao final>"
}

Regras de conteúdo (IMPORTANTES):
- Trate o tema de forma GERAL e educativa. NÃO invente números de tema repetitivo, súmula, número de processo, percentuais, prazos, valores ou datas específicas. Se algo depender de número exato, fale de forma genérica e oriente a confirmar com um profissional.
- Não prometa resultado nem afirme que a pessoa "tem direito" — explique que cada caso depende de análise.
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
    hook: parsed.hook || "",
    script: parsed.script || "",
    caption: parsed.caption || "",
  };
}

export async function generateScript({
  title,
  summary,
  link,
  format = "reel",
  duration = "medio",
}) {
  const formatoInstrucao = buildFormatoDuracao(format, duration);

  const prompt = `Você é roteirista de conteúdo jurídico para uma advogada de DIREITO PREVIDENCIÁRIO no Brasil. A partir da notícia abaixo, escreva um roteiro educativo.

${REGRAS_OAB}

${formatoInstrucao}

Responda APENAS com um JSON, sem texto antes ou depois:
{
  "hook": "<frase de abertura que prende a atenção, sem clickbait enganoso>",
  "script": "<roteiro completo no formato indicado>",
  "caption": "<legenda do post, educativa, com 3 a 5 hashtags relevantes ao final>"
}

Regras de conteúdo:
- Base-se SOMENTE no que a notícia diz. Não invente números de tema, súmula, processo, percentuais ou prazos que não estejam no texto.
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
    hook: parsed.hook || "",
    script: parsed.script || "",
    caption: parsed.caption || "",
  };
}

// ── 3. Verificação de conformidade com a OAB ──────────────────────────────
// Relê o roteiro à luz das regras de publicidade e aponta possíveis problemas.
// É um APOIO, não um carimbo jurídico — a palavra final é sempre da advogada.
export async function checkOAB({ hook, script, caption }) {
  const prompt = `Você é revisor de conformidade com as REGRAS DE PUBLICIDADE DA OAB. Analise o conteúdo de um post de Instagram de uma advogada de DIREITO PREVIDENCIÁRIO e diga se ele respeita as regras.

${REGRAS_OAB}

Procure por qualquer trecho que possa violar as regras: promessa ou garantia de resultado; captação de clientela; chamada para contato ("entre em contato", "agende", "chame no direct", etc.); mercantilização (preços, urgência comercial); autopromoção ("melhor", "especialista nº 1"); ou afirmar que a pessoa "tem direito" sem ressalva de análise do caso.

Responda APENAS com um JSON, sem texto antes ou depois:
{
  "conforme": <true se NÃO encontrou nenhum problema, false caso contrário>,
  "alertas": [
    { "problema": "<descreva o trecho ou a questão, citando o que está escrito>", "sugestao": "<como ajustar, em uma frase>" }
  ]
}

Se estiver tudo certo, devolva "conforme": true e "alertas": []. Seja criterioso, mas não invente problema onde não há: conteúdo educativo, em terceira pessoa, que oriente buscar um advogado de confiança de forma genérica, é permitido.

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

// Roda a verificação da OAB e devolve os campos já no formato para salvar no
// roteiro: oabConforme (bool) e oabAlertas (JSON em texto).
export async function evaluateOab({ hook, script, caption }) {
  const res = await checkOAB({ hook, script, caption });
  return {
    oabConforme: res.conforme,
    oabAlertas: JSON.stringify(res.alertas || []),
  };
}

// ── 4. Versão corrigida (ajusta os pontos apontados pela OAB) ──────────────
// Reescreve o roteiro corrigindo os alertas da verificação, mantendo tema,
// formato e duração aproximada. Devolve { hook, script, caption }.
export async function generateCorrected({
  title,
  summary,
  link,
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

  const prompt = `Você é roteirista de conteúdo jurídico para uma advogada de DIREITO PREVIDENCIÁRIO no Brasil. Abaixo está um roteiro que apresentou possíveis violações às regras de publicidade da OAB. Reescreva o roteiro CORRIGINDO esses pontos, mantendo o mesmo tema, o mesmo formato e a duração aproximada.

${REGRAS_OAB}

PONTOS A CORRIGIR (apontados na verificação):
${listaAlertas || "(nenhum ponto específico — apenas garanta total conformidade com as regras acima)"}

Responda APENAS com um JSON, sem texto antes ou depois:
{
  "hook": "<gancho corrigido>",
  "script": "<roteiro corrigido, no mesmo formato do original>",
  "caption": "<legenda corrigida, com 3 a 5 hashtags ao final>"
}

Regras de conteúdo:
- Corrija os pontos apontados sem inventar fatos novos. Não acrescente números de tema, súmula, processo, percentuais ou prazos que não estavam no original.
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
    hook: parsed.hook || hook,
    script: parsed.script || script,
    caption: parsed.caption || caption,
  };
}

// ── 5. Regeneração de UMA parte do roteiro ────────────────────────────────
// Reescreve só o gancho, só o roteiro (com duração) ou só a legenda, mantendo
// coerência com as outras partes (que vêm no parâmetro). Não salva nada e não
// roda OAB — só devolve o novo texto da parte pedida: { hook } | { script } |
// { caption }. A verificação da OAB acontece quando a edição é salva.
export async function regeneratePart({
  part,
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

  const prompt = `Você é roteirista de conteúdo jurídico para uma advogada de DIREITO PREVIDENCIÁRIO no Brasil. ${instrucao}

${REGRAS_OAB}

Responda APENAS com um JSON, sem texto antes ou depois:
{ "${campo}": "<novo conteúdo>" }

Regras de conteúdo:
- Base-se SOMENTE na origem indicada. Não invente números de tema, súmula, processo, percentuais ou prazos que não estejam no texto.
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
  const valor = parsed[campo];
  if (!valor || !String(valor).trim()) {
    throw new Error("resposta vazia da IA");
  }
  return { [campo]: String(valor) };
}

// ── Explicação de um tema/data (para a advogada ler antes de gerar) ────────
// Não é roteiro: é um resumo educativo do assunto, para a Sara decidir se vale
// virar conteúdo. Mantém a trava anti-invenção (geral, sem número/data inventados).
export async function explainTopic({ topic }) {
  const prompt = `Você é um assistente de DIREITO PREVIDENCIÁRIO no Brasil. Explique, de forma clara e educativa, PARA A PRÓPRIA ADVOGADA (que vai decidir se o assunto vale virar conteúdo), o seguinte tema ou data:

"${topic}"

Escreva de 2 a 4 parágrafos curtos cobrindo: o que é, o que acontece / como funciona, e por que é relevante para o segurado.

Regras:
- Trate o assunto de forma GERAL. NÃO invente números de tema repetitivo, súmula, número de processo, percentuais, prazos, valores ou datas específicas. Se algo depender de número exato, fale de forma genérica.
- Português do Brasil, claro e direto. Isto NÃO é um roteiro de post — é uma explicação para a advogada entender o assunto antes de decidir.
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

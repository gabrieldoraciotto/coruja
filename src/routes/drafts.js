import { Router } from "express";
import { prisma } from "../db.js";
import { getCadenceDays } from "../services/settings.js";
import { checkOAB, evaluateOab, generateCorrected, generateFromTopic, explainTopic, regeneratePart } from "../services/ai.js";
import { getNiche } from "../services/niche.js";

export const draftsRouter = Router();

// Lista roteiros, opcionalmente filtrando por status (?status=aprovado, etc.).
draftsRouter.get("/", async (req, res) => {
  const { status } = req.query;
  const drafts = await prisma.draft.findMany({
    where: status ? { status: String(status) } : undefined,
    orderBy: { createdAt: "desc" },
    include: { article: { include: { source: true } } },
  });
  res.json(drafts);
});

// Cria um roteiro a partir de um TEMA livre (pauta própria), sem notícia de
// origem. Verifica a OAB automaticamente, igual aos roteiros de notícia.
draftsRouter.post("/from-topic", async (req, res) => {
  const topic = String(req.body?.topic || "").trim();
  if (!topic) return res.status(400).json({ error: "informe o tema do roteiro" });
  const format = req.body?.format === "carrossel" ? "carrossel" : "reel";
  const nicho = await getNiche();

  try {
    const { hook, script, caption } = await generateFromTopic({ topic, format, nicho });
    const draft = await prisma.draft.create({
      data: { topic, format, hook, script, caption },
    });
    // Verificação automática da OAB (não bloqueia: se a IA falhar, segue sem o selo).
    try {
      const oab = await evaluateOab({ hook, script, caption, nicho });
      const comOab = await prisma.draft.update({ where: { id: draft.id }, data: oab });
      return res.status(201).json(comOab);
    } catch (e) {
      console.error("[oab] verificação automática falhou (pauta própria):", e.message);
      return res.status(201).json(draft);
    }
  } catch (err) {
    console.error("[from-topic] erro:", err.message);
    res.status(502).json({ error: "falha ao gerar roteiro do tema" });
  }
});

// Explica um tema/data (sem criar roteiro). Devolve { explanation }.
draftsRouter.post("/explain-topic", async (req, res) => {
  const topic = String(req.body?.topic || "").trim();
  if (!topic) return res.status(400).json({ error: "tema não informado" });
  try {
    const r = await explainTopic({ topic, nicho: await getNiche() });
    res.json(r);
  } catch (err) {
    console.error("[explain-topic] erro:", err.message);
    res.status(502).json({ error: "falha ao explicar o tema" });
  }
});

// Edita o conteúdo do roteiro (gancho, texto, legenda) e reverifica a OAB.
draftsRouter.patch("/:id", async (req, res) => {
  const { hook, script, caption } = req.body;
  const draft = await prisma.draft.update({
    where: { id: req.params.id },
    data: {
      ...(hook !== undefined && { hook }),
      ...(script !== undefined && { script }),
      ...(caption !== undefined && { caption }),
    },
  });
  // Reverifica com o texto editado (não bloqueia se a IA falhar).
  try {
    const oab = await evaluateOab({
      nicho: await getNiche(),
      hook: draft.hook,
      script: draft.script,
      caption: draft.caption,
    });
    const comOab = await prisma.draft.update({ where: { id: draft.id }, data: oab });
    return res.json(comOab);
  } catch (e) {
    console.error("[oab] reverificação após edição falhou:", e.message);
    return res.json(draft);
  }
});

// Gera uma NOVA versão de UMA parte do roteiro (hook | script | caption).
// Recebe o conteúdo atual no corpo (para manter coerência) e NÃO salva — devolve
// só o novo texto da parte pedida, para a tela colocar no formulário de edição.
// A verificação da OAB roda quando a Sara SALVA a edição (rota PATCH), não aqui.
draftsRouter.post("/:id/regenerate", async (req, res) => {
  const partesValidas = ["hook", "script", "caption"];
  const part = partesValidas.includes(req.body?.part) ? req.body.part : "script";
  const dursValidas = ["curto", "medio", "longo"];
  const duration = dursValidas.includes(req.body?.duration) ? req.body.duration : "medio";
  const { hook = "", script = "", caption = "" } = req.body || {};

  const draft = await prisma.draft.findUnique({
    where: { id: req.params.id },
    include: { article: true },
  });
  if (!draft) return res.status(404).json({ error: "roteiro não encontrado" });
  if (!draft.article && !draft.topic) {
    return res.status(409).json({ error: "roteiro sem origem" });
  }

  try {
    const novo = await regeneratePart({
      part,
      nicho: await getNiche(),
      duration,
      title: draft.article?.title,
      summary: draft.article?.summary,
      link: draft.article?.link,
      topic: draft.topic,
      format: draft.format,
      hook,
      script,
      caption,
    });
    res.json(novo); // { hook } | { script } | { caption } — sem salvar
  } catch (err) {
    console.error("[regenerate] erro:", err.message);
    res.status(502).json({ error: "falha ao gerar nova versão" });
  }
});

// Verifica a conformidade do roteiro com as regras da OAB (apenas leitura: não
// altera o roteiro nem grava nada). Devolve { conforme, alertas }.
draftsRouter.post("/:id/check-oab", async (req, res) => {
  const draft = await prisma.draft.findUnique({ where: { id: req.params.id } });
  if (!draft) return res.status(404).json({ error: "roteiro não encontrado" });

  try {
    const resultado = await checkOAB({
      nicho: await getNiche(),
      hook: draft.hook,
      script: draft.script,
      caption: draft.caption,
    });
    res.json(resultado);
  } catch (err) {
    console.error("[check-oab] erro:", err.message);
    res.status(502).json({ error: "falha ao verificar conformidade" });
  }
});

// Gera uma versão CORRIGIDA do roteiro, ajustando os pontos apontados na última
// verificação da OAB (oabAlertas), reverifica e sobrescreve o mesmo roteiro.
draftsRouter.post("/:id/fix-oab", async (req, res) => {
  const draft = await prisma.draft.findUnique({
    where: { id: req.params.id },
    include: { article: true },
  });
  if (!draft) return res.status(404).json({ error: "roteiro não encontrado" });
  if (!draft.article && !draft.topic) {
    return res.status(409).json({ error: "roteiro sem origem" });
  }

  let alertas = [];
  try {
    alertas = JSON.parse(draft.oabAlertas || "[]");
  } catch {
    alertas = [];
  }

  const nicho = await getNiche();
  try {
    const novo = await generateCorrected({
      nicho,
      title: draft.article?.title,
      summary: draft.article?.summary,
      link: draft.article?.link,
      topic: draft.topic,
      format: draft.format,
      hook: draft.hook,
      script: draft.script,
      caption: draft.caption,
      alertas,
    });
    // Reverifica a versão corrigida (não bloqueia se a IA falhar).
    let oab = { oabConforme: null, oabAlertas: null };
    try {
      oab = await evaluateOab({ ...novo, nicho });
    } catch (e) {
      console.error("[oab] reverificação após corrigir falhou:", e.message);
    }
    const atualizado = await prisma.draft.update({
      where: { id: draft.id },
      data: { hook: novo.hook, script: novo.script, caption: novo.caption, ...oab },
    });
    res.json(atualizado);
  } catch (err) {
    console.error("[fix-oab] erro:", err.message);
    res.status(502).json({ error: "falha ao gerar versão corrigida" });
  }
});

// Aprova: vai para a fila (sem dia ainda).
draftsRouter.post("/:id/approve", async (req, res) => {
  const draft = await prisma.draft.update({
    where: { id: req.params.id },
    data: { status: "aprovado", scheduledDate: null },
  });
  res.json(draft);
});

// Rejeita.
draftsRouter.post("/:id/reject", async (req, res) => {
  const draft = await prisma.draft.update({
    where: { id: req.params.id },
    data: { status: "rejeitado", scheduledDate: null },
  });
  res.json(draft);
});

// Agenda um roteiro num dia específico (arrastar para o calendário, ou tocar no
// celular). Só aceita se o dia for um dia de publicação. Vários roteiros podem
// cair no mesmo dia — não há limite por dia, só restrição de quais dias valem.
draftsRouter.post("/:id/schedule", async (req, res) => {
  const { date } = req.body; // "YYYY-MM-DD"
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ error: "date deve estar no formato YYYY-MM-DD" });
  }

  // Interpreta como meio-dia UTC para o dia não "virar" por causa de fuso horário.
  const dia = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(dia.getTime())) {
    return res.status(400).json({ error: "data inválida" });
  }

  const cadence = await getCadenceDays();
  if (!cadence.includes(dia.getUTCDay())) {
    return res.status(409).json({ error: "este dia não é um dia de publicação" });
  }

  const draft = await prisma.draft.update({
    where: { id: req.params.id },
    data: { status: "agendado", scheduledDate: dia },
  });
  res.json(draft);
});

// Devolve o roteiro para a fila (tira do dia). Usado quando a Sara troca de ideia
// sobre qual roteiro vai naquele dia.
draftsRouter.post("/:id/unschedule", async (req, res) => {
  const draft = await prisma.draft.update({
    where: { id: req.params.id },
    data: { status: "aprovado", scheduledDate: null },
  });
  res.json(draft);
});

// Marca como publicado (mantém o dia agendado).
draftsRouter.post("/:id/publish", async (req, res) => {
  const draft = await prisma.draft.update({
    where: { id: req.params.id },
    data: { status: "publicado" },
  });
  res.json(draft);
});

// Apaga o roteiro de vez. Se estiver agendado, sai do calendário junto.
draftsRouter.delete("/:id", async (req, res) => {
  try {
    await prisma.draft.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "roteiro não encontrado" });
    }
    console.error("[drafts delete] erro:", err.message);
    res.status(500).json({ error: "falha ao apagar o roteiro" });
  }
});

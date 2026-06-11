import { Router } from "express";
import { prisma } from "../db.js";
import { runIngestion } from "../services/ingest.js";
import { generateScript, evaluateOab } from "../services/ai.js";

export const articlesRouter = Router();

// Dispara a coleta manual dos feeds (também roda sozinha via cron).
articlesRouter.post("/ingest", async (_req, res) => {
  const result = await runIngestion();
  res.json(result);
});

// Lista notícias. Filtro opcional por status: ?status=relevante
articlesRouter.get("/", async (req, res) => {
  const { status } = req.query;
  const articles = await prisma.article.findMany({
    where: status ? { status: String(status) } : undefined,
    orderBy: [{ relevanceScore: "desc" }, { fetchedAt: "desc" }],
    include: { source: true, drafts: true },
  });
  res.json(articles);
});

// Gera um roteiro a partir de uma notícia. Body opcional: { format: "reel" | "carrossel" }
articlesRouter.post("/:id/generate", async (req, res) => {
  const article = await prisma.article.findUnique({ where: { id: req.params.id } });
  if (!article) return res.status(404).json({ error: "notícia não encontrada" });

  const format = req.body?.format === "carrossel" ? "carrossel" : "reel";

  try {
    const { hook, script, caption } = await generateScript({
      title: article.title,
      summary: article.summary,
      link: article.link,
      format,
    });
    const draft = await prisma.draft.create({
      data: { articleId: article.id, format, hook, script, caption },
    });
    // A notícia já rendeu roteiro: marca como "lida" para sair da fila de
    // relevantes e ir para a aba "Já lidas".
    await prisma.article.update({ where: { id: article.id }, data: { status: "lida" } });
    // Verificação automática da OAB. Não bloqueia: se a IA falhar, o roteiro é
    // criado mesmo assim, apenas sem o selo (oabConforme fica null).
    try {
      const oab = await evaluateOab({ hook, script, caption });
      const comOab = await prisma.draft.update({ where: { id: draft.id }, data: oab });
      return res.status(201).json(comOab);
    } catch (e) {
      console.error("[oab] verificação automática falhou na geração:", e.message);
      return res.status(201).json(draft);
    }
  } catch (err) {
    res.status(502).json({ error: "falha ao gerar roteiro", detail: err.message });
  }
});

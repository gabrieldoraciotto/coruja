import { Router } from "express";
import { prisma } from "../db.js";

export const sourcesRouter = Router();

// Lista as fontes cadastradas.
sourcesRouter.get("/", async (_req, res) => {
  const sources = await prisma.source.findMany({ orderBy: { name: "asc" } });
  res.json(sources);
});

// Cadastra uma nova fonte (feed RSS).
sourcesRouter.post("/", async (req, res) => {
  const { name, feedUrl, type } = req.body;
  if (!name || !feedUrl || !type) {
    return res.status(400).json({ error: "name, feedUrl e type são obrigatórios" });
  }
  try {
    const source = await prisma.source.create({ data: { name, feedUrl, type } });
    res.status(201).json(source);
  } catch {
    res.status(409).json({ error: "feedUrl já cadastrado" });
  }
});

// Ativa/desativa uma fonte.
sourcesRouter.patch("/:id", async (req, res) => {
  const { active } = req.body;
  const source = await prisma.source.update({
    where: { id: req.params.id },
    data: { active },
  });
  res.json(source);
});

// Apaga uma fonte de vez. PRESERVA os roteiros já criados: os roteiros gerados
// a partir das notícias dessa fonte são "soltos" (ficam sem notícia de origem,
// como uma pauta própria) antes de remover as notícias e a fonte.
sourcesRouter.delete("/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const artigos = await prisma.article.findMany({
      where: { sourceId: id },
      select: { id: true },
    });
    const artigoIds = artigos.map((a) => a.id);

    if (artigoIds.length) {
      // Solta os roteiros (mantém o trabalho do usuário) e remove as notícias.
      await prisma.draft.updateMany({
        where: { articleId: { in: artigoIds } },
        data: { articleId: null },
      });
      await prisma.article.deleteMany({ where: { sourceId: id } });
    }

    await prisma.source.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error("[sources] erro ao apagar:", err.message);
    res.status(500).json({ error: "falha ao apagar a fonte" });
  }
});

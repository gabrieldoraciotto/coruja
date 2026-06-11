import { Router } from "express";
import { prisma } from "../db.js";

export const calendarRouter = Router();

// Retorna os roteiros que já estão agendados num dia (com a notícia de origem).
// O frontend monta a grade do mês cruzando isto com os dias de publicação (/settings).
calendarRouter.get("/", async (_req, res) => {
  const agendados = await prisma.draft.findMany({
    where: { scheduledDate: { not: null } },
    orderBy: { scheduledDate: "asc" },
    include: { article: { include: { source: true } } },
  });
  res.json(agendados);
});

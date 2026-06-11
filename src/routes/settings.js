import { Router } from "express";
import { getCadenceDays, setCadenceDays } from "../services/settings.js";

export const settingsRouter = Router();

// Retorna os dias da semana de publicação (0=dom ... 6=sáb).
settingsRouter.get("/", async (_req, res) => {
  const cadenceDays = await getCadenceDays();
  res.json({ cadenceDays });
});

// Define os dias de publicação. Devolve para a fila os roteiros que ficaram
// agendados em dias que deixaram de valer.
settingsRouter.put("/", async (req, res) => {
  const { cadenceDays } = req.body;
  if (!Array.isArray(cadenceDays)) {
    return res
      .status(400)
      .json({ error: "cadenceDays deve ser um array de dias (0=dom ... 6=sáb)" });
  }
  const result = await setCadenceDays(cadenceDays);
  res.json(result);
});

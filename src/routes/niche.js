import { Router } from "express";
import { getNiche, setNiche } from "../services/niche.js";

export const nicheRouter = Router();

// Tema atual do canal.
nicheRouter.get("/", async (_req, res) => {
  res.json({ niche: await getNiche() });
});

// Troca o tema do canal (a IA passa a se moldar a ele na hora).
nicheRouter.put("/", async (req, res) => {
  const niche = await setNiche(req.body?.niche);
  res.json({ niche });
});

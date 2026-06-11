import express from "express";
import cors from "cors";
import cron from "node-cron";
import { config } from "./config.js";
import { runIngestion } from "./services/ingest.js";
import { sendDailyReminders } from "./services/reminders.js";
import { ensureSources } from "./services/sources-sync.js";
import { sourcesRouter } from "./routes/sources.js";
import { articlesRouter } from "./routes/articles.js";
import { draftsRouter } from "./routes/drafts.js";
import { calendarRouter } from "./routes/calendar.js";
import { settingsRouter } from "./routes/settings.js";

const app = express();
app.use(cors());
app.use(express.json());

// ── Porteiro: senha única do escritório ──────────────────────────────────
// Toda requisição precisa trazer a senha no cabeçalho "x-app-key".
// Liberados: o preflight do navegador (OPTIONS, que não carrega cabeçalhos
// customizados) e o GET / (health check do Railway).
// Se APP_PASSWORD não estiver definida, o app fica aberto (aviso no boot).
app.use((req, res, next) => {
  if (!config.appPassword) return next();
  if (req.method === "OPTIONS") return next();
  if (req.path === "/" && req.method === "GET") return next();
  if (req.headers["x-app-key"] === config.appPassword) return next();
  res.status(401).json({ error: "senha necessária" });
});

app.get("/", (_req, res) => res.json({ ok: true, service: "pauta-juridica" }));

app.use("/sources", sourcesRouter);
app.use("/articles", articlesRouter);
app.use("/drafts", draftsRouter);
app.use("/calendar", calendarRouter);
app.use("/settings", settingsRouter);

// Rotina diária às 7h (horário de Brasília): coleta de notícias + lembrete dos
// posts do dia. Sem o timezone explícito, o "7h" seria no relógio do servidor
// (UTC no Railway) — ou seja, 4h da manhã no Brasil.
// Cada etapa tem seu próprio try/catch — se uma falhar, a outra ainda roda.
cron.schedule(
  "0 7 * * *",
  async () => {
    console.log("[cron] rotina diária iniciada");
    try {
      const resultado = await runIngestion();
      console.log("[cron] coleta concluída:", resultado);
    } catch (err) {
      console.error("[cron] erro na coleta:", err.message);
    }
    try {
      const r = await sendDailyReminders(false, "manha");
      console.log("[cron] lembrete:", r);
    } catch (err) {
      console.error("[cron] erro no lembrete:", err.message);
    }
  },
  { timezone: "America/Sao_Paulo" }
);

// Reforço da tarde (15h de Brasília): só o lembrete, sem coleta. Como o post
// publicado muda de status, este e-mail só sai se ainda houver pendência do dia.
cron.schedule(
  "0 15 * * *",
  async () => {
    console.log("[cron] reforço da tarde iniciado");
    try {
      const r = await sendDailyReminders(false, "tarde");
      console.log("[cron] lembrete da tarde:", r);
    } catch (err) {
      console.error("[cron] erro no lembrete da tarde:", err.message);
    }
  },
  { timezone: "America/Sao_Paulo" }
);
console.log("[cron] rotinas agendadas: 07:00 e 15:00 (America/Sao_Paulo)");

// Teste manual do lembrete (ignora a trava do dia e tenta enviar agora).
app.post("/reminders/test", async (req, res) => {
  const period = req.body?.period === "tarde" ? "tarde" : "manha";
  try {
    const r = await sendDailyReminders(true, period);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`pauta-juridica rodando na porta ${config.port}`);
  if (!config.appPassword) {
    console.warn(
      "[auth] APP_PASSWORD não definida — o app está SEM senha (aberto). Defina a variável no Railway para proteger."
    );
  }
  // Garante as fontes padrão (Google Notícias, JOTA, Conjur) e corrige nomes.
  // Roda em segundo plano: se falhar, o app continua de pé normalmente.
  ensureSources().catch((e) => console.error("[sources] sync falhou:", e.message));
});

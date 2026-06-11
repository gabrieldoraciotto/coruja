import "dotenv/config";

const cadenceFromEnv = process.env.CADENCE_DAYS
  ? process.env.CADENCE_DAYS.split(",").map((d) => parseInt(d.trim(), 10))
  : null;

export const config = {
  port: process.env.PORT || 3333,
  // Senha única do escritório (defina APP_PASSWORD no Railway). Sem ela, o app
  // fica ABERTO — o index.js avisa no boot.
  appPassword: process.env.APP_PASSWORD,
  cadenceDays: cadenceFromEnv || [1, 3, 5],
  weeksAhead: parseInt(process.env.WEEKS_AHEAD || "4", 10),
  relevanceThreshold: parseInt(process.env.RELEVANCE_THRESHOLD || "60", 10),

  // ── Provedor de IA ────────────────────────────────────────────────────
  // Compatível com qualquer API no formato OpenAI. Troque AI_BASE_URL e os
  // modelos no .env para alternar entre provedores gratuitos.
  //
  // GEMINI (Google AI Studio) — pegue a chave em https://aistudio.google.com/apikey
  //   AI_BASE_URL = https://generativelanguage.googleapis.com/v1beta/openai/
  //   WRITER_MODEL = gemini-2.5-flash
  //   TRIAGE_MODEL = gemini-2.5-flash-lite
  //
  // GROQ — pegue a chave em https://console.groq.com/keys
  //   AI_BASE_URL = https://api.groq.com/openai/v1
  //   WRITER_MODEL = llama-3.3-70b-versatile
  //   TRIAGE_MODEL = llama-3.1-8b-instant
  //
  // (confirme os nomes de modelo atuais na documentação do provedor escolhido)
  ai: {
    apiKey: process.env.AI_API_KEY,
    baseUrl: process.env.AI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/",
    triageModel: process.env.TRIAGE_MODEL || "gemini-2.5-flash-lite",
    writerModel: process.env.WRITER_MODEL || "gemini-2.5-flash",
  },

  // ── E-mail de lembrete (Resend) ───────────────────────────────────────
  // Crie a conta em https://resend.com, gere a chave (RESEND_API_KEY), confirme
  // um remetente (REMINDER_FROM) e informe quem recebe (REMINDER_TO). Tudo isso
  // vai nas variáveis de ambiente do Railway — nunca no código.
  // APP_URL é opcional (link no rodapé do e-mail); já tem um padrão.
  email: {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.REMINDER_FROM,
    to: process.env.REMINDER_TO,
    appUrl: process.env.APP_URL || "https://pauta-juridica-web.vercel.app",
  },
};

// ── Fontes padrão ─────────────────────────────────────────────────────────
// Lista enxuta com o que funciona e é denso/confiável. As fontes mortas que
// testamos (STJ, CJF, Câmara, Senado, INSS/Previdência no gov.br) ficaram de
// fora de propósito — davam timeout/403/404/503. O ensureSources() garante que
// estas existam com o nome certo a cada boot (e conserta acento bugado).
export const seedSources = [
  {
    name: "Google Notícias — Previdência",
    feedUrl:
      "https://news.google.com/rss/search?q=INSS%20OR%20aposentadoria%20OR%20BPC%20OR%20%22auxilio-doenca%22%20OR%20%22pensao%20por%20morte%22&hl=pt-BR&gl=BR&ceid=BR:pt-419",
    type: "agregador",
  },
  {
    name: "JOTA",
    feedUrl: "https://www.jota.info/feed",
    type: "imprensa_juridica",
  },
  {
    name: "Consultor Jurídico (Conjur)",
    feedUrl: "https://www.conjur.com.br/rss.xml",
    type: "imprensa_juridica",
  },
];

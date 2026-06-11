import { config } from "../config.js";

// Envia um e-mail pela API do Resend (REST, sem dependência extra — usa o
// fetch nativo do Node 18+). Retorna:
//   - false  → não configurado (faltam variáveis); não é erro, só não envia.
//   - true   → enviado com sucesso.
//   - lança  → o Resend respondeu com erro (status != 2xx).
export async function sendEmail({ subject, html }) {
  const { apiKey, from, to } = config.email;

  if (!apiKey || !from || !to) {
    console.log(
      "[email] não configurado (faltam RESEND_API_KEY / REMINDER_FROM / REMINDER_TO) — e-mail não enviado."
    );
    return false;
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Resend respondeu ${resp.status}: ${txt}`);
  }

  console.log("[email] lembrete enviado com sucesso.");
  return true;
}

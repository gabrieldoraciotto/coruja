import { prisma } from "../db.js";
import { config } from "../config.js";
import { sendEmail } from "./email.js";

// "Hoje" às 12h UTC — bate com a forma como o scheduledDate é salvo
// (meio-dia UTC), pra evitar erro de fuso pegando o dia errado.
function hojeUtcNoon() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0)
  );
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Dois lembretes por dia, cada um com sua própria trava anti-repetição.
// O da tarde é um reforço: como o post publicado muda de status, a consulta
// só encontra o que AINDA está pendente — se tudo já foi postado, não sai e-mail.
const PERIODOS = {
  manha: {
    chave: "lastReminderSent.manha",
    assunto: (n) => `Pauta de hoje: ${n} post(s) para publicar`,
    titulo: "Pauta de hoje",
    intro: (n) => `Você tem ${n} post(s) agendado(s) para publicar hoje:`,
  },
  tarde: {
    chave: "lastReminderSent.tarde",
    assunto: (n) => `Lembrete: ainda ${n} post(s) para publicar hoje`,
    titulo: "Ainda dá tempo",
    intro: (n) =>
      `Ainda ${n === 1 ? "há 1 post agendado" : `há ${n} posts agendados`} para hoje aguardando publicação:`,
  },
};

async function marcarDia(chave, hojeStr) {
  await prisma.setting.upsert({
    where: { key: chave },
    update: { value: hojeStr },
    create: { key: chave, value: hojeStr },
  });
}

function montarEmail(periodo, agendados) {
  const itens = agendados
    .map(
      (d) =>
        `<li style="margin-bottom:12px;">` +
        `<strong style="color:#1B4332;">${escapeHtml(d.hook)}</strong><br/>` +
        `<span style="color:#8a7f6a;font-size:13px;">${
          d.format === "carrossel" ? "Carrossel" : "Reel"
        }</span></li>`
    )
    .join("");

  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;` +
    `background:#F5F0E8;padding:28px;border-radius:16px;color:#2A241E;">` +
    `<p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#B07D3A;margin:0 0 4px;">Pauta Jurídica</p>` +
    `<h1 style="font-size:22px;color:#1B4332;margin:0 0 16px;">${periodo.titulo}</h1>` +
    `<p style="margin:0 0 16px;">${periodo.intro(agendados.length)}</p>` +
    `<ul style="padding-left:18px;margin:0 0 22px;">${itens}</ul>` +
    `<a href="${config.email.appUrl}" style="display:inline-block;background:#1B4332;` +
    `color:#F5F0E8;text-decoration:none;padding:11px 20px;border-radius:999px;font-size:14px;">Abrir o painel</a>` +
    `</div>`
  );
}

// Envia o lembrete dos roteiros agendados para hoje.
// period: "manha" | "tarde" — define o texto e a trava usada.
// force = true → ignora a trava do dia e tenta enviar mesmo assim (para teste).
export async function sendDailyReminders(force = false, period = "manha") {
  const periodo = PERIODOS[period] || PERIODOS.manha;
  const hoje = hojeUtcNoon();
  const hojeStr = ymd(hoje);

  if (!force) {
    const marca = await prisma.setting
      .findUnique({ where: { key: periodo.chave } })
      .catch(() => null);
    if (marca?.value === hojeStr) {
      console.log(`[reminders] ${period}: já avisado hoje — pulando.`);
      return { sent: false, period, reason: "já avisado hoje" };
    }
  }

  const inicio = hoje;
  const fim = new Date(hoje.getTime() + 24 * 3600 * 1000);
  const agendados = await prisma.draft.findMany({
    where: { status: "agendado", scheduledDate: { gte: inicio, lt: fim } },
    orderBy: { createdAt: "asc" },
  });

  if (agendados.length === 0) {
    console.log(`[reminders] ${period}: nada agendado (ou tudo já publicado) para hoje.`);
    if (!force) await marcarDia(periodo.chave, hojeStr);
    return { sent: false, period, count: 0 };
  }

  const enviado = await sendEmail({
    subject: periodo.assunto(agendados.length),
    html: montarEmail(periodo, agendados),
  });

  // Só marca o dia se realmente enviou (se não estiver configurado, sendEmail
  // devolve false e a gente tenta de novo no próximo ciclo, já configurado).
  if (enviado && !force) await marcarDia(periodo.chave, hojeStr);

  return { sent: enviado, period, count: agendados.length };
}

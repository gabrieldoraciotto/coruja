import { prisma } from "../db.js";

// Dias padrão de publicação (0=domingo ... 6=sábado). Default: seg, qua, sex.
// Pode vir do .env como "1,3,5"; vira o ponto de partida até o usuário escolher na tela.
const DEFAULT_CADENCE = (
  process.env.CADENCE_DAYS
    ? process.env.CADENCE_DAYS.split(",").map((d) => parseInt(d.trim(), 10))
    : [1, 3, 5]
).filter((n) => !Number.isNaN(n));

// Lê os dias da semana de publicação salvos no banco (ou o default).
export async function getCadenceDays() {
  const row = await prisma.setting.findUnique({ where: { key: "cadenceDays" } });
  if (!row) return DEFAULT_CADENCE;
  try {
    const arr = JSON.parse(row.value);
    return Array.isArray(arr) ? arr : DEFAULT_CADENCE;
  } catch {
    return DEFAULT_CADENCE;
  }
}

// Salva os novos dias e DEVOLVE PARA A FILA os roteiros agendados (ainda não
// publicados) que caíam num dia da semana que deixou de ser válido.
export async function setCadenceDays(days) {
  const clean = [
    ...new Set(
      days
        .map((d) => parseInt(d, 10))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    ),
  ];

  await prisma.setting.upsert({
    where: { key: "cadenceDays" },
    update: { value: JSON.stringify(clean) },
    create: { key: "cadenceDays", value: JSON.stringify(clean) },
  });

  const agendados = await prisma.draft.findMany({
    where: { status: "agendado", scheduledDate: { not: null } },
  });

  let devolvidos = 0;
  for (const d of agendados) {
    const weekday = new Date(d.scheduledDate).getUTCDay();
    if (!clean.includes(weekday)) {
      await prisma.draft.update({
        where: { id: d.id },
        data: { status: "aprovado", scheduledDate: null },
      });
      devolvidos++;
    }
  }

  return { cadenceDays: clean, devolvidos };
}

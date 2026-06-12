import { prisma } from "../db.js";
import { config } from "../config.js";

// Data de hoje no fuso de Brasília, formato YYYY-MM-DD (vira a chave do dia).
function hojeSP() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

// Teto diário de gerações do playground: protege a cota gratuita da IA de
// um visitante (ou um bot) entusiasmado demais. O contador vive na tabela de
// configurações com a data na chave — e o reset noturno apaga as chaves
// velhas junto com todo o resto.
export async function consumirGeracao() {
  const key = `geracoes:${hojeSP()}`;
  const row = await prisma.setting.findUnique({ where: { key } }).catch(() => null);
  const usado = parseInt(row?.value || "0", 10);
  if (usado >= config.dailyGenerationLimit) {
    const err = new Error(
      `A demo atingiu o limite de ${config.dailyGenerationLimit} gerações de hoje. Amanhã tudo recomeça — os dados são limpos toda madrugada.`
    );
    err.quota = true;
    throw err;
  }
  await prisma.setting.upsert({
    where: { key },
    update: { value: String(usado + 1) },
    create: { key, value: "1" },
  });
}

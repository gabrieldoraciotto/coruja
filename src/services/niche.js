import { prisma } from "../db.js";
import { config } from "../config.js";

// O tema do canal mora na tabela de configurações (chave "niche").
// Sem valor salvo, vale o padrão do config — e o reset noturno da demo
// devolve tudo ao padrão.
export async function getNiche() {
  const row = await prisma.setting.findUnique({ where: { key: "niche" } }).catch(() => null);
  const valor = row?.value?.trim();
  return valor || config.defaultNiche;
}

export async function setNiche(value) {
  const v = String(value || "").trim().slice(0, 200);
  if (!v) return getNiche();
  await prisma.setting.upsert({
    where: { key: "niche" },
    update: { value: v },
    create: { key: "niche", value: v },
  });
  return v;
}

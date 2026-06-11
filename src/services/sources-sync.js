import { prisma } from "../db.js";
import { seedSources } from "../config.js";
import { getNiche, syncNicheSource } from "./niche.js";

// Garante, a cada boot, que as fontes padrão existem e que a fonte dinâmica
// do tema aponta para o tema atual do canal.
//
// É de propósito GENTIL: só cria o que falta e ajusta nome/tipo do que existe.
// NÃO desativa nem apaga nada — fontes adicionadas pela aba Fontes continuam
// sob controle de quem as criou (até o reset noturno da demo).
export async function ensureSources() {
  for (const s of seedSources) {
    try {
      await prisma.source.upsert({
        where: { feedUrl: s.feedUrl },
        update: { name: s.name, type: s.type },
        create: s,
      });
    } catch (err) {
      console.error(`[sources] falha ao garantir ${s.name}: ${err.message}`);
    }
  }
  await syncNicheSource(await getNiche());
  console.log("[sources] fontes padrão garantidas.");
}

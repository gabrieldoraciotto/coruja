import { prisma } from "../db.js";
import { seedSources } from "../config.js";

// Garante, a cada boot do app, que as fontes padrão existem com o nome correto.
// É o que mantém o feed do Google Notícias como fonte fixa (mesmo num ambiente
// novo) e corrige nomes gravados com acento bugado (ex.: "Consultor Jur�dico"
// volta a ser "Consultor Jurídico"). A correspondência é pelo feedUrl.
//
// É de propósito GENTIL: só cria as fontes que faltam e ajusta o nome/tipo das
// que existem. NÃO desativa nem apaga nada — as fontes que a Sara liga/desliga
// pela aba Fontes continuam sob controle dela.
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
  console.log(`[sources] fontes padrão garantidas (${seedSources.length}).`);
}

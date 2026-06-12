import { prisma } from "../db.js";
import { ensureSources } from "./sources-sync.js";

// Reset noturno do playground: cumpre a promessa do banner do site —
// roteiros, notícias, fontes e configurações voltam ao padrão de fábrica
// toda madrugada. A ordem de exclusão respeita as relações entre as tabelas
// (roteiro → notícia → fonte). Depois, re-semeia a fonte dinâmica do tema
// padrão, deixando a casa pronta para o primeiro visitante do dia.
export async function resetDemo() {
  const d = await prisma.draft.deleteMany({});
  const a = await prisma.article.deleteMany({});
  const f = await prisma.source.deleteMany({});
  const c = await prisma.setting.deleteMany({});
  await ensureSources();
  console.log(
    `[reset] demo zerada: ${d.count} roteiro(s), ${a.count} notícia(s), ${f.count} fonte(s), ${c.count} configuração(ões). Tema e fonte padrão restaurados.`
  );
}

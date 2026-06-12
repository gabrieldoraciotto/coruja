import { prisma } from "../db.js";
import { config } from "../config.js";

// Nome fixo da fonte dinâmica — é por ele que o app a reconhece para atualizar.
export const NICHE_SOURCE_NAME = "Google Notícias — tema do canal";

// Monta a busca do Google Notícias para um tema livre.
export function buildGoogleNewsUrl(niche) {
  const q = encodeURIComponent(niche);
  return `https://news.google.com/rss/search?q=${q}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
}

// Garante que a fonte dinâmica existe e aponta para o tema atual.
// Chamada ao salvar o tema e no boot — assim as notícias sempre acompanham
// o assunto do canal, sem o visitante precisar mexer na aba Fontes.
export async function syncNicheSource(niche) {
  const feedUrl = buildGoogleNewsUrl(niche);
  try {
    const existente = await prisma.source.findFirst({
      where: { name: NICHE_SOURCE_NAME },
    });
    if (existente) {
      if (existente.feedUrl !== feedUrl || !existente.active) {
        await prisma.source.update({
          where: { id: existente.id },
          data: { feedUrl, active: true },
        });
        console.log(`[sources] fonte do tema atualizada para: ${niche}`);
      }
    } else {
      await prisma.source.create({
        data: { name: NICHE_SOURCE_NAME, feedUrl, type: "agregador" },
      });
      console.log(`[sources] fonte do tema criada para: ${niche}`);
    }
  } catch (err) {
    // Colisão de feedUrl (alguém adicionou a mesma busca à mão) ou afins:
    // não derruba o salvamento do tema por causa da fonte.
    console.error(`[sources] falha ao sincronizar a fonte do tema: ${err.message}`);
  }
}

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
  const anterior = await getNiche();
  await prisma.setting.upsert({
    where: { key: "niche" },
    update: { value: v },
    create: { key: "niche", value: v },
  });
  // A fonte de notícias acompanha o tema na hora.
  await syncNicheSource(v);
  // Trocar de tema = redação nova: as notícias do tema anterior saem da mesa
  // (inclusive as que ainda estavam na fila de triagem). Ficam apenas as que
  // já viraram roteiro — apagá-las quebraria os roteiros criados delas.
  if (anterior !== v) {
    try {
      const r = await prisma.article.deleteMany({ where: { drafts: { none: {} } } });
      console.log(`[niche] tema trocado ("${anterior}" → "${v}") — ${r.count} notícia(s) do tema anterior removida(s).`);
    } catch (err) {
      console.error(`[niche] falha ao limpar notícias do tema anterior: ${err.message}`);
    }
  }
  return v;
}

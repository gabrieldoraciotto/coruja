import Parser from "rss-parser";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { triageArticle } from "./ai.js";
import { getNiche } from "./niche.js";

const parser = new Parser({ timeout: 10000 });

// Roda várias promessas com concorrência limitada (não enfileira tudo, mas
// também não dispara 50 de uma vez e estoura o limite da IA).
async function mapLimit(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, worker));
}

// Lê todos os feeds ativos, salva notícias novas (sem duplicar) e faz a triagem.
export async function runIngestion() {
  const sources = await prisma.source.findMany({ where: { active: true } });

  // 1) Busca TODOS os feeds em paralelo. Um feed lento/quebrado não segura os outros.
  const resultados = await Promise.allSettled(
    sources.map((s) => parser.parseURL(s.feedUrl))
  );

  // 2) Junta os itens válidos, já anotando a fonte de origem.
  const itens = [];
  resultados.forEach((res, idx) => {
    const source = sources[idx];
    if (res.status === "fulfilled") {
      const lista = res.value.items || [];
      for (const item of lista) {
        const link = item.link?.trim();
        if (link) itens.push({ source, item, link });
      }
      console.log(`[ingest] ${source.name}: ok (${lista.length} itens)`);
    } else {
      const msg = res.reason?.message || res.reason;
      console.error(`[ingest] falha em ${source.name}: ${msg}`);
    }
  });

  // 3) Deduplicação em LOTE: uma única consulta descobre o que já existe.
  const links = [...new Set(itens.map((x) => x.link))];
  const existentes = links.length
    ? await prisma.article.findMany({
        where: { link: { in: links } },
        select: { link: true },
      })
    : [];
  const jaExiste = new Set(existentes.map((a) => a.link));

  // 4) Monta a lista de novos (deduplicando também dentro do próprio lote).
  // Cada novo já entra marcado como "nova notícia" (isNew: true).
  const vistos = new Set();
  const novos = [];
  for (const { source, item, link } of itens) {
    if (jaExiste.has(link) || vistos.has(link)) continue;
    vistos.add(link);
    novos.push({
      sourceId: source.id,
      title: item.title || "(sem título)",
      link,
      summary: item.contentSnippet || item.content || null,
      publishedAt: item.isoDate ? new Date(item.isoDate) : null,
      isNew: true,
    });
  }

  // 5) Insere tudo de uma vez. Antes, tira a marca "nova" do lote anterior — só
  // o lote recém-coletado fica marcado. Se não veio nada novo, mantém as marcas
  // atuais (não some o "nova" à toa).
  if (novos.length) {
    await prisma.article.updateMany({ where: { isNew: true }, data: { isNew: false } });
    await prisma.article.createMany({ data: novos, skipDuplicates: true });
  }

  await triageNovas();
  return { novas: novos.length };
}

// Faz a triagem de relevância das notícias ainda "novas", várias ao mesmo tempo.
async function triageNovas() {
  const pendentes = await prisma.article.findMany({ where: { status: "novo" } });
  const nicho = await getNiche();

  await mapLimit(pendentes, 4, async (art) => {
    try {
      const { score, reason } = await triageArticle({
        title: art.title,
        summary: art.summary,
        nicho,
      });
      await prisma.article.update({
        where: { id: art.id },
        data: {
          relevanceScore: score,
          relevanceReason: reason,
          status: score >= config.relevanceThreshold ? "relevante" : "descartado",
        },
      });
    } catch (err) {
      console.error(`[triagem] falha no artigo ${art.id}: ${err.message}`);
    }
  });
}

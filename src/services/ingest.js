import Parser from "rss-parser";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { triageArticlesBatch } from "./ai.js";
import { getNiche } from "./niche.js";

const parser = new Parser({ timeout: 10000 });

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

  // Triagem em segundo plano: a resposta volta na hora e a página acompanha
  // o progresso. O trabalhador drena a fila em lotes, um de cada vez.
  iniciarTriagem();
  return { novas: novos.length };
}

// Faz a triagem de relevância das notícias ainda "novas", várias ao mesmo tempo.
// Tamanho do lote do trabalhador: o free tier da IA tem limite de tokens POR
// MINUTO, então a fila é drenada aos poucos (2 em paralelo, lotes de 40).
const LOTE_TRIAGEM = 40;

// Trava simples: garante UM trabalhador de triagem por vez (clique repetido em
// Coletar ou o cron das 7h não criam triagens concorrentes brigando por cota).
let triagemEmAndamento = false;

// Exportada: o boot do app chama para RETOMAR a fila pendente — sem isso,
// cada deploy/reinício do Railway matava o trabalhador no meio do serviço
// e a fila ficava órfã até alguém clicar em Coletar de novo.
export function iniciarTriagem() {
  if (triagemEmAndamento) {
    console.log("[triagem] já há uma triagem em andamento — novas notícias entram na mesma fila.");
    return;
  }
  triagemEmAndamento = true;
  (async () => {
    try {
      // Quem falhar (429 persistente etc.) continua "novo", mas não é retentado
      // nesta rodada — fica para a próxima coleta. Evita rodar para sempre.
      const tentados = new Set();
      while (true) {
        const fila = await prisma.article.findMany({
          where: { status: "novo" },
          orderBy: { fetchedAt: "desc" },
        });
        const lote = fila.filter((a) => !tentados.has(a.id)).slice(0, LOTE_TRIAGEM);
        if (lote.length === 0) break;
        lote.forEach((a) => tentados.add(a.id));
        console.log(`[triagem] processando lote de ${lote.length} (fila: ${fila.length}).`);

        const nicho = await getNiche();
        // Grupos de 8 notícias por chamada de IA: ~1400 tokens por chamada,
        // uma a cada 15s ≈ 4 chamadas/min ≈ 5600 tokens/min — dentro do teto
        // de 6000/min do free tier, triando ~32 notícias por minuto (~3x mais
        // que uma chamada por notícia).
        const POR_CHAMADA = 8;
        for (let i = 0; i < lote.length; i += POR_CHAMADA) {
          const grupo = lote.slice(i, i + POR_CHAMADA);
          try {
            const notas = await triageArticlesBatch({
              items: grupo.map((a) => ({
                id: a.id,
                title: a.title,
                // 280 caracteres bastam para dar nota — e economizam tokens.
                summary: (a.summary || "").slice(0, 280),
              })),
              nicho,
            });
            for (const art of grupo) {
              const nota = notas.get(art.id);
              if (!nota) {
                console.error(`[triagem] sem nota para ${art.id} — fica para a próxima rodada.`);
                continue;
              }
              await prisma.article.update({
                where: { id: art.id },
                data: {
                  relevanceScore: nota.score,
                  relevanceReason: nota.reason,
                  status: nota.score >= config.relevanceThreshold ? "relevante" : "descartado",
                },
              });
            }
          } catch (err) {
            console.error(`[triagem] falha no grupo de ${grupo.length}: ${err.message}`);
          }
          await new Promise((r) => setTimeout(r, 15000));
        }
      }
    } catch (err) {
      console.error("[triagem] trabalhador interrompido:", err.message);
    } finally {
      triagemEmAndamento = false;
      console.log("[triagem] fila drenada.");
    }
  })();
}

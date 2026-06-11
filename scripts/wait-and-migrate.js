import { PrismaClient } from "@prisma/client";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const prisma = new PrismaClient();

async function waitForDatabase(maxAttempts = 30) {
  console.log("[db] aguardando banco de dados...");
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log("[db] ✓ conectado ao banco");
      return true;
    } catch (err) {
      console.log(`[db] tentativa ${i + 1}/${maxAttempts} falhou, aguardando...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("[db] timeout ao conectar ao banco de dados");
}

async function runMigrations() {
  return new Promise((resolve, reject) => {
    console.log("[migrate] rodando migrações do Prisma...");
    const migrate = spawn("npx", ["prisma", "db", "push", "--skip-generate"], {
      cwd: join(__dirname, ".."),
      stdio: "inherit",
    });

    migrate.on("close", (code) => {
      if (code === 0) {
        console.log("[migrate] ✓ migrações concluídas");
        resolve();
      } else {
        reject(new Error(`Prisma migration failed with code ${code}`));
      }
    });

    migrate.on("error", reject);
  });
}

async function startApp() {
  return new Promise((resolve, reject) => {
    console.log("[app] iniciando aplicação...");
    const app = spawn("node", ["src/index.js"], {
      cwd: join(__dirname, ".."),
      stdio: "inherit",
    });

    app.on("error", reject);
  });
}

async function main() {
  try {
    await waitForDatabase();
    await prisma.$disconnect();
    await runMigrations();
    await startApp();
  } catch (err) {
    console.error("[error]", err.message);
    process.exit(1);
  }
}

main();

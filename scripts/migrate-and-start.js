import { execSync } from "child_process";

console.log("[init] iniciando migrações...");
try {
  // --accept-data-loss: necessário porque esta atualização remove a tabela Slot.
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
  });
  console.log("[init] ✓ migrações concluídas");
} catch (err) {
  // Se a migração falhar, NÃO sobe o app com o banco desatualizado — aborta para
  // o erro ficar visível, em vez de derrubar a aplicação depois com banco quebrado.
  console.error("[init] ✗ erro nas migrações:", err.message);
  process.exit(1);
}

console.log("[init] iniciando aplicação...");
execSync("node src/index.js", { stdio: "inherit" });

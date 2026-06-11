import { PrismaClient } from "@prisma/client";
import { seedSources } from "../src/config.js";

const prisma = new PrismaClient();

async function main() {
  for (const s of seedSources) {
    await prisma.source.upsert({
      where: { feedUrl: s.feedUrl },
      update: {},
      create: s,
    });
    console.log(`fonte garantida: ${s.name}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });

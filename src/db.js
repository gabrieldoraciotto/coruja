import { PrismaClient } from "@prisma/client";

// Cliente único do Prisma, reaproveitado por toda a aplicação.
export const prisma = new PrismaClient();

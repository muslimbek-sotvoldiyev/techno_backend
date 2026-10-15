import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function seed() {
  await prisma.$transaction(async (tx) => {
    await tx.category.upsert({
      where: { name: 'Kotyollar' },
      update: {},
      create: { name: 'Kotyollar' },
    });
    await tx.warehouse.upsert({
      where: { name: 'Asosiy ombor' },
      update: {},
      create: { name: 'Asosiy ombor', address: 'Manzilni sozlamalarda kiriting' },
    });
  });
}

seed().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());

import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(projectRoot, ".env") });

const prisma = new PrismaClient();

const ACCOUNT_ID = "demo-account-1";
const TOTAL_CONTACTS = 2500;
const BATCH_SIZE = 500;

async function seed() {
  // Clean up previous seed data
  await prisma.bulkActionLog.deleteMany();
  await prisma.bulkAction.deleteMany();
  await prisma.contact.deleteMany({ where: { accountId: ACCOUNT_ID } });

  // Insert contacts in batches to keep DB load manageable
  for (let offset = 0; offset < TOTAL_CONTACTS; offset += BATCH_SIZE) {
    const count = Math.min(BATCH_SIZE, TOTAL_CONTACTS - offset);

    const contacts: Prisma.ContactCreateManyInput[] = [];
    for (let i = 0; i < count; i++) {
      const index = offset + i;
      contacts.push({
        id: randomUUID(),
        accountId: ACCOUNT_ID,
        name: `Contact ${index + 1}`,
        email: `contact${index + 1}@example.com`,
        age: 20 + (index % 50),
        status: index % 7 === 0 ? "inactive" : "active",
      });
    }

    await prisma.contact.createMany({ data: contacts });
  }

  console.log(`Seeded ${TOTAL_CONTACTS} contacts for account "${ACCOUNT_ID}"`);
}

seed()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

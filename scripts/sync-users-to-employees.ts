import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting Users → Employees sync...");

  const users = await prisma.user.findMany({
    include: {
      role: true,
      linkedEmployee: true,
    },
  });

  let created = 0;
  let skipped = 0;

  for (const user of users) {
    if (user.linkedEmployee) {
      skipped++;
      continue;
    }

    const tempCode =
      `TMP-USER-${String(created + 1).padStart(4, "0")}`;

    await prisma.employee.create({
      data: {
        companyId: user.companyId,

        employeeId: tempCode,

        name: user.fullName,

        email: user.email,

        phone: user.phone || "",

        jobTitle: user.role?.name || "Operator",

        status: "ON_DUTY",

        linkedUserId: user.id,

        createdById: user.createdById || null,
      },
    });

    created++;

    console.log(
      `Created Employee → ${user.fullName} (${tempCode})`
    );
  }

  console.log("");
  console.log(`Done`);
  console.log(`Created: ${created}`);
  console.log(`Skipped: ${skipped}`);
}

main()
  .catch((e) => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const OPERATION_ID = "cmrmgtbtn0007fshogtghkeeh";

async function main() {

  const operation = await prisma.operation.findUnique({
    where: {
      id: OPERATION_ID
    },
    include: {
      asset: true
    }
  });

  if (!operation) {
    console.log("Operation not found");
    return;
  }

  console.log("\n========== OPERATION ==========\n");

  console.log({
    operationId: operation.id,
    operationNo: operation.operationNo,
    assetId: operation.assetId,
    projectIdAtOperation: operation.projectIdAtOperation,
    operationDate:
      operation.completedAt ||
      operation.approvedAt ||
      operation.createdAt,
  });

  console.log("\n========== ASSET ==========\n");

  console.log(operation.asset);

  console.log("\n========== ASSIGNMENT HISTORY ==========\n");

  const history = await prisma.assetAssignmentHistory.findMany({
    where:{
      assetId: operation.assetId
    },
    orderBy:{
      assignedAt:"asc"
    }
  });

  console.table(history);

}

main()
.finally(async()=>{
  await prisma.$disconnect();
});

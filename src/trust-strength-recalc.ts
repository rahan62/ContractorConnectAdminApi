import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
export async function getTrustStrengthConfig() {
  let row = await prisma.trustStrengthConfig.findUnique({ where: { id: 1 } });
  if (!row) {
    row = await prisma.trustStrengthConfig.create({
      data: {
        id: 1,
        experienceDefault: 45,
        strengthPointsDefault: new Prisma.Decimal(2),
        pointsPerTradeCategory: new Prisma.Decimal(2),
        pointsIso9001: new Prisma.Decimal(1),
        usdPerStrengthPoint: new Prisma.Decimal(333333)
      }
    });
  }
  return row;
}

export async function recalculateStrengthPointsForUser(userId: string): Promise<void> {
  const config = await getTrustStrengthConfig();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { companyHasIso9001: true }
  });
  if (!user) return;

  const [categoryCount, evidenceSum] = await Promise.all([
    prisma.userSubcontractorMainCategory.count({ where: { userId } }),
    prisma.categoryExperienceApprovalRequest.aggregate({
      where: { userId, status: "APPROVED" },
      _sum: { declaredEvidenceValueUsd: true }
    })
  ]);

  const totalUsd = Number(evidenceSum._sum.declaredEvidenceValueUsd ?? 0);
  const usdPer = Number(config.usdPerStrengthPoint);
  const evidencePts = usdPer > 0 ? totalUsd / usdPer : 0;
  const catPts = Number(config.pointsPerTradeCategory) * categoryCount;
  const isoPts = user.companyHasIso9001 ? Number(config.pointsIso9001) : 0;
  const points = catPts + isoPts + evidencePts;

  await prisma.user.update({
    where: { id: userId },
    data: { strengthPoints: new Prisma.Decimal(points) }
  });
}

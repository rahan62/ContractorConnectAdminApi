import bcrypt from "bcryptjs";
import { prisma } from "./prisma";

export async function verifyOperatorCredentials(email: string, password: string) {
  const operator = await prisma.operator.findUnique({
    where: { email, isActive: true }
  });
  if (!operator) return null;

  const ok = await bcrypt.compare(password, operator.passwordHash);
  if (!ok) return null;

  return operator;
}

export async function isGranted(operatorId: string, permissionCode: string) {
  const op = await prisma.operator.findUnique({
    where: { id: operatorId, isActive: true },
    include: {
      roles: {
        include: {
          role: {
            include: {
              permissions: {
                include: { permission: true }
              }
            }
          }
        }
      }
    }
  });

  if (!op) return false;

  const codes = new Set<string>();
  for (const or of op.roles) {
    for (const rp of or.role.permissions) {
      codes.add(rp.permission.code);
    }
  }

  return codes.has(permissionCode) || codes.has("admin.access");
}


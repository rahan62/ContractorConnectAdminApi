import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
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

function getAdminJwtSecret() {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) {
    throw new Error("ADMIN_JWT_SECRET is not configured");
  }
  return secret;
}

export function signAdminToken(operatorId: string) {
  return jwt.sign({ operatorId }, getAdminJwtSecret(), {
    expiresIn: "12h"
  });
}

export function verifyAdminToken(token: string): { operatorId: string } | null {
  try {
    const payload = jwt.verify(token, getAdminJwtSecret()) as { operatorId?: string };
    if (!payload.operatorId) {
      return null;
    }
    return { operatorId: payload.operatorId };
  } catch {
    return null;
  }
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


import path from "node:path";
import { config as loadEnv } from "dotenv";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

// Load Admin API .env first; if missing DATABASE_URL, reuse main app .env (same DB in dev).
const adminApiRoot = path.resolve(__dirname, "..");
loadEnv({ path: path.join(adminApiRoot, ".env") });
if (!process.env.DATABASE_URL?.trim()) {
  loadEnv({ path: path.join(adminApiRoot, "..", "ContractorConnect", ".env") });
}
if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    "DATABASE_URL is not set. Create ContractorConnectAdminApi/.env (see .env.example) " +
      "with DATABASE_URL, or add DATABASE_URL to ContractorConnect/.env."
  );
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  // Define all base permissions
  const permissionCodes = [
    "admin.access",
    "admin.view_dashboard",
    "roles.view",
    "roles.create",
    "roles.edit",
    "roles.delete",
    "roles.assign_permissions",
    "permissions.view",
    "permissions.create",
    "permissions.edit",
    "permissions.delete",
    "operators.view",
    "operators.create", // add_operator
    "operators.edit",
    "operators.delete",
    "operators.assign_roles",
    "users.view",
    "users.edit",
    "users.view_documents",
    "manual_registrations.view",
    "manual_registrations.view_documents",
    "manual_registrations.approve",
    "manual_registrations.reject",
    "contracts.view",
    "contracts.edit",
    "contracts.delete",
    "complaints.view",
    "complaints.edit_status",
    "complaints.comment",
    "payments.view",
    "teams.view",
    "teams.edit",
    "monetization.view",
    "monetization.edit",
    "category_experience.view",
    "category_experience.review"
  ];

  const permissions = [];
  for (const code of permissionCodes) {
    permissions.push(
      await prisma.permission.upsert({
        where: { code },
        update: {},
        create: { code }
      })
    );
  }

  // Create Super Admin role with all permissions
  const superAdminRole = await prisma.role.upsert({
    where: { name: "Super Admin" },
    update: {},
    create: {
      name: "Super Admin",
      description: "Full access to all admin features"
    }
  });

  // Attach all permissions to Super Admin role
  await prisma.rolePermission.deleteMany({
    where: { roleId: superAdminRole.id }
  });

  await prisma.rolePermission.createMany({
    data: permissions.map(p => ({
      roleId: superAdminRole.id,
      permissionId: p.id
    })),
    skipDuplicates: true
  });

  // Create initial super admin operator
  const email = process.env.ADMIN_SUPER_EMAIL || "admin@taseron.local";
  const plainPassword = process.env.ADMIN_SUPER_PASSWORD || "ChangeMe123!";
  const passwordHash = await bcrypt.hash(plainPassword, 10);

  const operator = await prisma.operator.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: "Super Admin",
      passwordHash,
      isActive: true
    }
  });

  // Attach Super Admin role to this operator
  await prisma.operatorRole.upsert({
    where: {
      operatorId_roleId: {
        operatorId: operator.id,
        roleId: superAdminRole.id
      }
    },
    update: {},
    create: {
      operatorId: operator.id,
      roleId: superAdminRole.id
    }
  });

  console.log("Seeded admin permissions, roles and super admin operator.");
  console.log(`Super admin email: ${email}`);
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


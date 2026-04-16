import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { ComplaintStatus, ContractStatus, Prisma, ProfessionRequestStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { recalculateStrengthPointsForUser } from "./trust-strength-recalc";
import { verifyAdminToken, verifyOperatorCredentials, isGranted, signAdminToken } from "./auth";
import { verifyTurnstile } from "./turnstile";

const app = express();

const defaultCorsOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://admin.yuklenicim.com",
  "https://admin.taseron.org"
];
const corsOrigins = process.env.ADMIN_CORS_ORIGINS?.split(",")
  .map(s => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : defaultCorsOrigins
  })
);
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    service: "yuklenicim-admin-api",
    message: "No resource at /. Use GET /api/admin/health for a health check.",
    health: "/api/admin/health"
  });
});

type MonetizationConfig = {
  monthlySubscriptionPrice: number;
  yearlySubscriptionPrice: number;
  featuredListingPrice: number;
  tokenUnitPrice: number;
  vatRate: number;
  // Token costs per action (configurable from admin UI)
  tokensPerContract: number;
  tokensPerBid: number;
  tokensPerAvailabilityPost: number;
  tokensPerUrgentJob: number;
};

let monetizationConfig: MonetizationConfig = {
  monthlySubscriptionPrice: Number(process.env.ADMIN_MONTHLY_SUBSCRIPTION_PRICE || 1999),
  yearlySubscriptionPrice: Number(process.env.ADMIN_YEARLY_SUBSCRIPTION_PRICE || 19999),
  featuredListingPrice: Number(process.env.ADMIN_FEATURED_LISTING_PRICE || 499),
  tokenUnitPrice: Number(process.env.ADMIN_TOKEN_UNIT_PRICE || 10),
  vatRate: Number(process.env.ADMIN_VAT_RATE || 20),
  tokensPerContract: Number(process.env.ADMIN_TOKENS_PER_CONTRACT || 5),
  tokensPerBid: Number(process.env.ADMIN_TOKENS_PER_BID || 1),
  tokensPerAvailabilityPost: Number(process.env.ADMIN_TOKENS_PER_AVAILABILITY_POST || 1),
  tokensPerUrgentJob: Number(process.env.ADMIN_TOKENS_PER_URGENT_JOB || 3)
};

const CONTRACT_STATUSES = Object.values(ContractStatus);
const COMPLAINT_STATUSES = Object.values(ComplaintStatus);

function parseOptionalDate(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseOptionalInt(value: unknown) {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function parseOptionalBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function parseContractStatus(value: unknown): ContractStatus | undefined {
  return typeof value === "string" && CONTRACT_STATUSES.includes(value as ContractStatus)
    ? (value as ContractStatus)
    : undefined;
}

function parseComplaintStatus(value: unknown): ComplaintStatus | undefined {
  return typeof value === "string" && COMPLAINT_STATUSES.includes(value as ComplaintStatus)
    ? (value as ComplaintStatus)
    : undefined;
}

function requirePermission(code: string) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const operatorId = getAuthenticatedOperatorId(req);
    if (!operatorId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const allowed = await isGranted(operatorId, code);
    if (!allowed) {
      return res.status(403).json({ message: "Forbidden" });
    }

    (req as any).operatorId = operatorId;
    next();
  };
}

function getAuthenticatedOperatorId(req: express.Request) {
  const authHeader = req.header("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return null;
  }

  const payload = verifyAdminToken(token);
  return payload?.operatorId ?? null;
}

app.get("/api/admin/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/admin/auth/login", async (req, res) => {
  const { email, password, turnstileToken } = req.body as {
    email: string;
    password: string;
    turnstileToken?: string;
  };

  const ok = await verifyTurnstile(turnstileToken);
  if (!ok) {
    return res.status(400).json({ message: "Turnstile verification failed" });
  }

  const operator = await verifyOperatorCredentials(email, password);
  if (!operator) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  res.json({
    operatorId: operator.id,
    name: operator.name,
    email: operator.email,
    accessToken: signAdminToken(operator.id)
  });
});

app.get("/api/admin/dashboard", requirePermission("admin.view_dashboard"), async (_req, res) => {
  const [users, pendingRegistrations, openComplaints, contracts, revenue] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({
      where: {
        isVerified: false,
        userType: { in: ["CONTRACTOR", "SUBCONTRACTOR", "TEAM"] }
      }
    }),
    prisma.complaint.count({
      where: {
        status: { in: ["OPEN", "IN_PROGRESS"] }
      }
    }),
    prisma.contract.count(),
    prisma.payment.aggregate({
      where: { status: "COMPLETED" },
      _sum: { amount: true }
    })
  ]);

  res.json({
    users,
    pendingRegistrations,
    openComplaints,
    contracts,
    revenue: revenue._sum.amount ?? 0
  });
});

app.get("/api/admin/users", requirePermission("users.view"), async (req, res) => {
  const { userType, isVerified } = req.query;
  const where: any = {};

  if (userType) {
    const types = Array.isArray(userType) ? userType : String(userType).split(",");
    where.userType = { in: types };
  }

  if (typeof isVerified !== "undefined") {
    where.isVerified = String(isVerified) === "true";
  }

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        userType: true,
        companyName: true,
        companyTaxOffice: true,
        companyTaxNumber: true,
        authorizedPersonName: true,
        authorizedPersonPhone: true,
        signatureAuthDocUrl: true,
        taxCertificateDocUrl: true,
        tradeRegistryGazetteDocUrl: true,
        isVerified: true,
        createdAt: true
      },
      orderBy: { createdAt: "desc" },
      take: 100
    }),
    prisma.user.count({ where })
  ]);

  res.json({ items, total });
});

app.get("/api/admin/users/:id", async (req, res) => {
  const operatorId = getAuthenticatedOperatorId(req);
  if (!operatorId) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const canViewUser = await isGranted(operatorId, "users.view");
  const canViewDocs = await isGranted(operatorId, "users.view_documents");
  if (!canViewUser && !canViewDocs) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      userType: true,
      companyName: true,
      bio: true,
      companyTaxOffice: true,
      companyTaxNumber: true,
      authorizedPersonName: true,
      authorizedPersonPhone: true,
      signatureAuthDocUrl: true,
      taxCertificateDocUrl: true,
      tradeRegistryGazetteDocUrl: true,
      logoUrl: true,
      bannerUrl: true,
      tokenBalance: true,
      isVerified: true,
      createdAt: true
    }
  });

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  res.json(user);
});

app.post("/api/admin/users/:id/add-tokens", requirePermission("users.edit"), async (req, res) => {
  const amount = parseOptionalInt(req.body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ message: "Amount must be a positive integer" });
  }

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: {
      tokenBalance: {
        increment: amount
      }
    },
    select: {
      id: true,
      tokenBalance: true
    }
  });

  res.json(user);
});

app.get("/api/admin/registrations", requirePermission("manual_registrations.view"), async (_req, res) => {
  const items = await prisma.user.findMany({
    where: {
      isVerified: false,
      userType: { in: ["CONTRACTOR", "SUBCONTRACTOR", "TEAM"] }
    },
    select: {
      id: true,
      email: true,
      userType: true,
      companyName: true,
      companyTaxOffice: true,
      companyTaxNumber: true,
      authorizedPersonName: true,
      authorizedPersonPhone: true,
      signatureAuthDocUrl: true,
      taxCertificateDocUrl: true,
      tradeRegistryGazetteDocUrl: true,
      isVerified: true,
      createdAt: true
    },
    orderBy: { createdAt: "desc" },
    take: 100
  });

  res.json({ items });
});

app.patch("/api/admin/users/:id/verify", requirePermission("manual_registrations.approve"), async (req, res) => {
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { isVerified: true }
  });

  res.json(user);
});

app.get("/api/admin/contracts", requirePermission("contracts.view"), async (req, res) => {
  const status = parseContractStatus(req.query.status);
  const where = status ? { status } : undefined;

  const items = await prisma.contract.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      budget: true,
      currency: true,
      startsAt: true,
      totalDays: true,
      createdAt: true,
      contractor: {
        select: { id: true, companyName: true, email: true }
      },
      client: {
        select: { id: true, companyName: true, email: true }
      },
      _count: {
        select: { bids: true, comments: true, complaints: true }
      }
    }
  });

  res.json({ items });
});

app.patch("/api/admin/contracts/:id", requirePermission("contracts.edit"), async (req, res) => {
  const { title, description, status, budget, currency, startsAt, totalDays, endsAt, clientId, contractorId } =
    req.body as Record<string, unknown>;

  const updated = await prisma.contract.update({
    where: { id: req.params.id },
    data: {
      title: typeof title === "string" ? title : undefined,
      description: typeof description === "string" ? description : undefined,
      status: parseContractStatus(status),
      budget: parseOptionalInt(budget),
      currency: typeof currency === "string" ? currency : undefined,
      startsAt: parseOptionalDate(startsAt),
      totalDays: parseOptionalInt(totalDays),
      endsAt: parseOptionalDate(endsAt),
      clientId: typeof clientId === "string" ? clientId : clientId === null ? null : undefined,
      contractorId:
        typeof contractorId === "string" ? contractorId : contractorId === null ? null : undefined
    }
  });

  res.json(updated);
});

app.get("/api/admin/complaints", requirePermission("complaints.view"), async (req, res) => {
  const status = parseComplaintStatus(req.query.status);
  const where = status ? { status } : undefined;

  const items = await prisma.complaint.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      createdAt: true,
      user: {
        select: { id: true, companyName: true, email: true }
      },
      contract: {
        select: { id: true, title: true, status: true }
      }
    }
  });

  res.json({ items });
});

app.patch("/api/admin/complaints/:id", requirePermission("complaints.edit_status"), async (req, res) => {
  const { status } = req.body as { status?: string };

  const updated = await prisma.complaint.update({
    where: { id: req.params.id },
    data: {
      status: parseComplaintStatus(status)
    }
  });

  res.json(updated);
});

app.get("/api/admin/payments", requirePermission("payments.view"), async (_req, res) => {
  const [items, totals] = await Promise.all([
    prisma.payment.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
        user: {
          select: { id: true, companyName: true, email: true }
        },
        contract: {
          select: { id: true, title: true }
        }
      }
    }),
    prisma.payment.groupBy({
      by: ["status"],
      _sum: { amount: true }
    })
  ]);

  res.json({ items, totals });
});

app.patch("/api/admin/payments/:id/refund", requirePermission("payments.refund"), async (req, res) => {
  const payment = await prisma.payment.update({
    where: { id: req.params.id },
    data: { status: "REFUNDED" }
  });

  res.json(payment);
});

app.get("/api/admin/teams", requirePermission("teams.view"), async (_req, res) => {
  const items = await prisma.team.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      name: true,
      createdAt: true,
      leader: {
        select: { id: true, name: true, email: true, companyName: true }
      },
      _count: {
        select: { members: true }
      }
    }
  });

  res.json({ items });
});

app.patch("/api/admin/teams/:id", requirePermission("teams.edit"), async (req, res) => {
  const { name, leaderId } = req.body as { name?: string; leaderId?: string };

  const updated = await prisma.team.update({
    where: { id: req.params.id },
    data: {
      name: typeof name === "string" ? name : undefined,
      leaderId: typeof leaderId === "string" ? leaderId : undefined
    }
  });

  res.json(updated);
});

app.get("/api/admin/operators", requirePermission("operators.view"), async (_req, res) => {
  const items = await prisma.operator.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      name: true,
      isActive: true,
      createdAt: true,
      roles: {
        include: {
          role: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }
    }
  });

  res.json({
    items: items.map(item => ({
      ...item,
      roles: item.roles.map(roleLink => roleLink.role)
    }))
  });
});

app.post("/api/admin/operators", requirePermission("operators.create"), async (req, res) => {
  const { email, name, password, isActive, roleIds } = req.body as {
    email?: string;
    name?: string;
    password?: string;
    isActive?: boolean;
    roleIds?: string[];
  };

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const operator = await prisma.operator.create({
    data: {
      email,
      name,
      passwordHash,
      isActive: isActive ?? true,
      roles: roleIds?.length
        ? {
            create: roleIds.map(roleId => ({
              roleId
            }))
          }
        : undefined
    }
  });

  res.status(201).json(operator);
});

app.patch("/api/admin/operators/:id", requirePermission("operators.edit"), async (req, res) => {
  const { email, name, password, isActive } = req.body as {
    email?: string;
    name?: string;
    password?: string;
    isActive?: boolean;
  };

  const updated = await prisma.operator.update({
    where: { id: req.params.id },
    data: {
      email: typeof email === "string" ? email : undefined,
      name: typeof name === "string" ? name : undefined,
      isActive: parseOptionalBoolean(isActive),
      passwordHash: password ? await bcrypt.hash(password, 10) : undefined
    }
  });

  res.json(updated);
});

app.patch("/api/admin/operators/:id/roles", requirePermission("operators.assign_roles"), async (req, res) => {
  const { roleIds } = req.body as { roleIds?: string[] };
  const ids = Array.isArray(roleIds) ? roleIds : [];

  await prisma.$transaction([
    prisma.operatorRole.deleteMany({ where: { operatorId: req.params.id } }),
    ...(ids.length
      ? [
          prisma.operatorRole.createMany({
            data: ids.map(roleId => ({
              operatorId: req.params.id,
              roleId
            }))
          })
        ]
      : [])
  ]);

  const operator = await prisma.operator.findUnique({
    where: { id: req.params.id },
    include: {
      roles: {
        include: {
          role: true
        }
      }
    }
  });

  res.json(operator);
});

app.get("/api/admin/roles", requirePermission("roles.view"), async (_req, res) => {
  const items = await prisma.role.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      permissions: {
        include: {
          permission: true
        }
      },
      _count: {
        select: {
          operators: true
        }
      }
    }
  });

  res.json({
    items: items.map(item => ({
      ...item,
      permissions: item.permissions.map(permissionLink => permissionLink.permission)
    }))
  });
});

app.post("/api/admin/roles", requirePermission("roles.create"), async (req, res) => {
  const { name, description } = req.body as { name?: string; description?: string };

  if (!name) {
    return res.status(400).json({ message: "Role name is required" });
  }

  const role = await prisma.role.create({
    data: {
      name,
      description
    }
  });

  res.status(201).json(role);
});

app.patch("/api/admin/roles/:id", requirePermission("roles.edit"), async (req, res) => {
  const { name, description } = req.body as { name?: string; description?: string };

  const role = await prisma.role.update({
    where: { id: req.params.id },
    data: {
      name: typeof name === "string" ? name : undefined,
      description: typeof description === "string" ? description : undefined
    }
  });

  res.json(role);
});

app.delete("/api/admin/roles/:id", requirePermission("roles.delete"), async (req, res) => {
  await prisma.role.delete({
    where: { id: req.params.id }
  });

  res.json({ ok: true });
});

app.get("/api/admin/permissions", requirePermission("permissions.view"), async (_req, res) => {
  const items = await prisma.permission.findMany({
    orderBy: { code: "asc" }
  });

  res.json({ items });
});

app.post("/api/admin/permissions", requirePermission("permissions.create"), async (req, res) => {
  const { code, description } = req.body as { code?: string; description?: string };

  if (!code) {
    return res.status(400).json({ message: "Permission code is required" });
  }

  const permission = await prisma.permission.create({
    data: {
      code,
      description
    }
  });

  res.status(201).json(permission);
});

app.patch("/api/admin/permissions/:id", requirePermission("permissions.edit"), async (req, res) => {
  const { code, description } = req.body as { code?: string; description?: string };

  const permission = await prisma.permission.update({
    where: { id: req.params.id },
    data: {
      code: typeof code === "string" ? code : undefined,
      description: typeof description === "string" ? description : undefined
    }
  });

  res.json(permission);
});

app.delete("/api/admin/permissions/:id", requirePermission("permissions.delete"), async (req, res) => {
  await prisma.permission.delete({
    where: { id: req.params.id }
  });

  res.json({ ok: true });
});

app.patch("/api/admin/roles/:id/permissions", requirePermission("roles.assign_permissions"), async (req, res) => {
  const { permissionIds } = req.body as { permissionIds?: string[] };
  const ids = Array.isArray(permissionIds) ? permissionIds : [];

  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { roleId: req.params.id } }),
    ...(ids.length
      ? [
          prisma.rolePermission.createMany({
            data: ids.map(permissionId => ({
              roleId: req.params.id,
              permissionId
            }))
          })
        ]
      : [])
  ]);

  const role = await prisma.role.findUnique({
    where: { id: req.params.id },
    include: {
      permissions: {
        include: {
          permission: true
        }
      }
    }
  });

  res.json(role);
});

app.get("/api/admin/monetization", requirePermission("monetization.view"), async (_req, res) => {
  const [completedPayments, refundedPayments, users, activeContracts, dbConfig] = await Promise.all([
    prisma.payment.aggregate({
      where: { status: "COMPLETED" },
      _sum: { amount: true },
      _count: { id: true }
    }),
    prisma.payment.aggregate({
      where: { status: "REFUNDED" },
      _sum: { amount: true },
      _count: { id: true }
    }),
    prisma.user.count(),
    prisma.contract.count({
      where: {
        status: { in: ["OPEN_FOR_BIDS", "ACTIVE"] }
      }
    }),
    prisma.monetizationConfig.findFirst()
  ]);

  if (dbConfig) {
    monetizationConfig = {
      ...monetizationConfig,
      monthlySubscriptionPrice: dbConfig.monthlySubscriptionPrice,
      yearlySubscriptionPrice: dbConfig.yearlySubscriptionPrice,
      featuredListingPrice: dbConfig.featuredListingPrice,
      tokenUnitPrice: dbConfig.tokenUnitPrice,
      vatRate: dbConfig.vatRate,
      tokensPerContract: dbConfig.tokensPerContract,
      tokensPerBid: dbConfig.tokensPerBid,
      tokensPerAvailabilityPost: dbConfig.tokensPerAvailabilityPost,
      tokensPerUrgentJob: dbConfig.tokensPerUrgentJob
    };
  }

  res.json({
    config: monetizationConfig,
    stats: {
      completedRevenue: completedPayments._sum.amount ?? 0,
      completedPayments: completedPayments._count.id,
      refundedRevenue: refundedPayments._sum.amount ?? 0,
      refundedPayments: refundedPayments._count.id,
      totalUsers: users,
      activeContracts
    }
  });
});

app.patch("/api/admin/monetization", requirePermission("monetization.edit"), async (req, res) => {
  monetizationConfig = {
    monthlySubscriptionPrice:
      parseOptionalInt(req.body.monthlySubscriptionPrice) ?? monetizationConfig.monthlySubscriptionPrice,
    yearlySubscriptionPrice:
      parseOptionalInt(req.body.yearlySubscriptionPrice) ?? monetizationConfig.yearlySubscriptionPrice,
    featuredListingPrice:
      parseOptionalInt(req.body.featuredListingPrice) ?? monetizationConfig.featuredListingPrice,
    tokenUnitPrice: parseOptionalInt(req.body.tokenUnitPrice) ?? monetizationConfig.tokenUnitPrice,
    vatRate: parseOptionalInt(req.body.vatRate) ?? monetizationConfig.vatRate,
    tokensPerContract:
      parseOptionalInt(req.body.tokensPerContract) ?? monetizationConfig.tokensPerContract,
    tokensPerBid: parseOptionalInt(req.body.tokensPerBid) ?? monetizationConfig.tokensPerBid,
    tokensPerAvailabilityPost:
      parseOptionalInt(req.body.tokensPerAvailabilityPost) ?? monetizationConfig.tokensPerAvailabilityPost,
    tokensPerUrgentJob:
      parseOptionalInt(req.body.tokensPerUrgentJob) ?? monetizationConfig.tokensPerUrgentJob
  };

  await prisma.monetizationConfig.upsert({
    where: { id: 1 },
    update: {
      monthlySubscriptionPrice: monetizationConfig.monthlySubscriptionPrice,
      yearlySubscriptionPrice: monetizationConfig.yearlySubscriptionPrice,
      featuredListingPrice: monetizationConfig.featuredListingPrice,
      tokenUnitPrice: monetizationConfig.tokenUnitPrice,
      vatRate: monetizationConfig.vatRate,
      tokensPerContract: monetizationConfig.tokensPerContract,
      tokensPerBid: monetizationConfig.tokensPerBid,
      tokensPerAvailabilityPost: monetizationConfig.tokensPerAvailabilityPost,
      tokensPerUrgentJob: monetizationConfig.tokensPerUrgentJob
    },
    create: {
      id: 1,
      monthlySubscriptionPrice: monetizationConfig.monthlySubscriptionPrice,
      yearlySubscriptionPrice: monetizationConfig.yearlySubscriptionPrice,
      featuredListingPrice: monetizationConfig.featuredListingPrice,
      tokenUnitPrice: monetizationConfig.tokenUnitPrice,
      vatRate: monetizationConfig.vatRate,
      tokensPerContract: monetizationConfig.tokensPerContract,
      tokensPerBid: monetizationConfig.tokensPerBid,
      tokensPerAvailabilityPost: monetizationConfig.tokensPerAvailabilityPost,
      tokensPerUrgentJob: monetizationConfig.tokensPerUrgentJob
    }
  });

  res.json({ config: monetizationConfig });
});

app.get("/api/admin/trust-strength", requirePermission("trust_strength.view"), async (_req, res) => {
  const row =
    (await prisma.trustStrengthConfig.findUnique({ where: { id: 1 } })) ??
    (await prisma.trustStrengthConfig.create({
      data: {
        id: 1,
        experienceDefault: 45,
        strengthPointsDefault: new Prisma.Decimal(2),
        pointsPerTradeCategory: new Prisma.Decimal(2),
        pointsIso9001: new Prisma.Decimal(1),
        usdPerStrengthPoint: new Prisma.Decimal(333333)
      }
    }));

  res.json({
    config: {
      experienceDefault: row.experienceDefault,
      strengthPointsDefault: Number(row.strengthPointsDefault),
      pointsPerTradeCategory: Number(row.pointsPerTradeCategory),
      pointsIso9001: Number(row.pointsIso9001),
      usdPerStrengthPoint: Number(row.usdPerStrengthPoint),
      strengthTiersJson: row.strengthTiersJson
    }
  });
});

app.patch("/api/admin/trust-strength", requirePermission("trust_strength.edit"), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const prev = await prisma.trustStrengthConfig.findUnique({ where: { id: 1 } });

  const experienceDefault = parseOptionalInt(body.experienceDefault);
  const strengthPointsDefault = parseOptionalNumber(body.strengthPointsDefault);
  const pointsPerTradeCategory = parseOptionalNumber(body.pointsPerTradeCategory);
  const pointsIso9001 = parseOptionalNumber(body.pointsIso9001);
  const usdPerStrengthPoint = parseOptionalNumber(body.usdPerStrengthPoint);

  let tiersUpdate: Prisma.InputJsonValue | null | undefined;
  if (Object.prototype.hasOwnProperty.call(body, "strengthTiersJson")) {
    if (body.strengthTiersJson === null) {
      tiersUpdate = null;
    } else if (Array.isArray(body.strengthTiersJson)) {
      tiersUpdate = body.strengthTiersJson as Prisma.InputJsonValue;
    } else {
      return res.status(400).json({ message: "strengthTiersJson must be an array or null" });
    }
  }

  const data: Prisma.TrustStrengthConfigUpdateInput = {};
  if (experienceDefault !== undefined && experienceDefault !== null) {
    data.experienceDefault = experienceDefault;
  }
  if (strengthPointsDefault !== undefined) data.strengthPointsDefault = new Prisma.Decimal(strengthPointsDefault);
  if (pointsPerTradeCategory !== undefined)
    data.pointsPerTradeCategory = new Prisma.Decimal(pointsPerTradeCategory);
  if (pointsIso9001 !== undefined) data.pointsIso9001 = new Prisma.Decimal(pointsIso9001);
  if (usdPerStrengthPoint !== undefined) data.usdPerStrengthPoint = new Prisma.Decimal(usdPerStrengthPoint);
  if (tiersUpdate !== undefined) {
    data.strengthTiersJson = tiersUpdate === null ? Prisma.DbNull : tiersUpdate;
  }

  if (Object.keys(data).length === 0) {
    const row = prev ?? (await prisma.trustStrengthConfig.findUnique({ where: { id: 1 } }));
    if (!row) {
      return res.status(404).json({ message: "Trust strength config not found" });
    }
    return res.json({
      config: {
        experienceDefault: row.experienceDefault,
        strengthPointsDefault: Number(row.strengthPointsDefault),
        pointsPerTradeCategory: Number(row.pointsPerTradeCategory),
        pointsIso9001: Number(row.pointsIso9001),
        usdPerStrengthPoint: Number(row.usdPerStrengthPoint),
        strengthTiersJson: row.strengthTiersJson
      }
    });
  }

  const row = await prisma.trustStrengthConfig.upsert({
    where: { id: 1 },
    update: data,
    create: {
      id: 1,
      experienceDefault:
        experienceDefault != null ? experienceDefault : (prev?.experienceDefault ?? 45),
      strengthPointsDefault: new Prisma.Decimal(strengthPointsDefault ?? Number(prev?.strengthPointsDefault ?? 2)),
      pointsPerTradeCategory: new Prisma.Decimal(
        pointsPerTradeCategory ?? Number(prev?.pointsPerTradeCategory ?? 2)
      ),
      pointsIso9001: new Prisma.Decimal(pointsIso9001 ?? Number(prev?.pointsIso9001 ?? 1)),
      usdPerStrengthPoint: new Prisma.Decimal(usdPerStrengthPoint ?? Number(prev?.usdPerStrengthPoint ?? 333333)),
      strengthTiersJson:
        tiersUpdate !== undefined
          ? tiersUpdate === null
            ? Prisma.DbNull
            : tiersUpdate
          : prev?.strengthTiersJson === null || prev?.strengthTiersJson === undefined
            ? Prisma.DbNull
            : (prev.strengthTiersJson as Prisma.InputJsonValue)
    }
  });

  res.json({
    config: {
      experienceDefault: row.experienceDefault,
      strengthPointsDefault: Number(row.strengthPointsDefault),
      pointsPerTradeCategory: Number(row.pointsPerTradeCategory),
      pointsIso9001: Number(row.pointsIso9001),
      usdPerStrengthPoint: Number(row.usdPerStrengthPoint),
      strengthTiersJson: row.strengthTiersJson
    }
  });
});

const CATEGORY_EXPERIENCE_STATUSES = Object.values(ProfessionRequestStatus);

app.get("/api/admin/category-experience-requests", requirePermission("category_experience.view"), async (req, res) => {
  const statusParam = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const status =
    statusParam && CATEGORY_EXPERIENCE_STATUSES.includes(statusParam as ProfessionRequestStatus)
      ? (statusParam as ProfessionRequestStatus)
      : undefined;

  const items = await prisma.categoryExperienceApprovalRequest.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    include: {
      user: {
        select: { id: true, email: true, companyName: true, userType: true }
      },
      mainCategory: {
        select: { id: true, slug: true, nameEn: true, nameTr: true }
      },
      reviewedByOperator: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  res.json({ items });
});

app.patch(
  "/api/admin/category-experience-requests/:id",
  requirePermission("category_experience.review"),
  async (req, res) => {
    const id = req.params.id;
    const body = req.body as {
      status?: string;
      reviewerNote?: string | null;
      declaredEvidenceValueUsd?: number | null;
    };
    const nextStatus =
      typeof body.status === "string" && CATEGORY_EXPERIENCE_STATUSES.includes(body.status as ProfessionRequestStatus)
        ? (body.status as ProfessionRequestStatus)
        : undefined;

    if (nextStatus !== "APPROVED" && nextStatus !== "REJECTED") {
      return res.status(400).json({ message: "status must be APPROVED or REJECTED" });
    }

    const reviewerNote =
      typeof body.reviewerNote === "string" && body.reviewerNote.trim() ? body.reviewerNote.trim() : null;

    const operatorId = (req as express.Request & { operatorId?: string }).operatorId;
    if (!operatorId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const existing = await prisma.categoryExperienceApprovalRequest.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        mainCategoryId: true,
        status: true
      }
    });

    if (!existing) {
      return res.status(404).json({ message: "Request not found" });
    }
    if (existing.status !== "PENDING") {
      return res.status(400).json({ message: "Only pending requests can be reviewed" });
    }

    try {
      const updated = await prisma.$transaction(async tx => {
        if (nextStatus === "APPROVED") {
          await tx.userSubcontractorMainCategory.upsert({
            where: {
              userId_mainCategoryId: {
                userId: existing.userId,
                mainCategoryId: existing.mainCategoryId
              }
            },
            create: {
              userId: existing.userId,
              mainCategoryId: existing.mainCategoryId
            },
            update: {}
          });
        }

        const evidencePatch: { declaredEvidenceValueUsd?: Prisma.Decimal | null } = {};
        if (nextStatus === "APPROVED" && Object.prototype.hasOwnProperty.call(body, "declaredEvidenceValueUsd")) {
          const raw = body.declaredEvidenceValueUsd;
          if (raw === null) {
            evidencePatch.declaredEvidenceValueUsd = null;
          } else {
            const n = typeof raw === "number" ? raw : Number(raw);
            if (!Number.isFinite(n) || n < 0) {
              throw new Error("INVALID_EVIDENCE_USD");
            }
            evidencePatch.declaredEvidenceValueUsd = new Prisma.Decimal(n);
          }
        }

        return tx.categoryExperienceApprovalRequest.update({
          where: { id },
          data: {
            status: nextStatus,
            reviewerNote,
            reviewedAt: new Date(),
            reviewedByOperatorId: operatorId,
            ...evidencePatch
          },
          include: {
            user: {
              select: { id: true, email: true, companyName: true, userType: true }
            },
            mainCategory: {
              select: { id: true, slug: true, nameEn: true, nameTr: true }
            },
            reviewedByOperator: {
              select: { id: true, name: true, email: true }
            }
          }
        });
      });

      void recalculateStrengthPointsForUser(existing.userId).catch(err =>
        console.error("[category-experience] strength recalc", err)
      );

      return res.json(updated);
    } catch (e) {
      if (e instanceof Error && e.message === "INVALID_EVIDENCE_USD") {
        return res.status(400).json({ message: "declaredEvidenceValueUsd must be null or a non-negative number" });
      }
      console.error("[category-experience-requests PATCH]", e);
      return res.status(500).json({ message: "Failed to update request" });
    }
  }
);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Admin API listening on port ${port}`);
});

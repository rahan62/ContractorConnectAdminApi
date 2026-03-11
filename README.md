## ContractorConnectAdminApi – Admin Backend

Express + Prisma backend that powers the `ContractorConnectAdmin` panel, reconstructed from the architecture notes.

- **Stack**: Node.js, Express, TypeScript, Prisma (PostgreSQL), bcrypt, Turnstile server-side verification.
- **Intended endpoints**:
  - `POST /api/admin/auth/login` – credentials + Turnstile login for admins/operators.
  - `GET /api/admin/users` – list users with filters (`userType`, `isVerified`).
  - `PATCH /api/admin/users/:id/verify` – manual approval of contractor/sub-contractor registrations.
  - Additional `GET` routes for contracts, complaints, payments, teams, operators, roles, monetization.
- **Next steps**:
  - Add `prisma/schema.prisma` mirroring the main app User model (company fields, docs, monetization, `isVerified`).
  - Implement `src/index.ts` with the endpoints described above, including Turnstile verification and dev-mode bypass.


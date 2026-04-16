import { Prisma } from "@prisma/client";

export type StrengthTier = { minPoints: number; label: string };

export const DEFAULT_STRENGTH_TIERS: StrengthTier[] = [
  { minPoints: 0, label: "K" },
  { minPoints: 4, label: "J" },
  { minPoints: 8, label: "I" },
  { minPoints: 12, label: "H" },
  { minPoints: 16, label: "G" },
  { minPoints: 20, label: "F" },
  { minPoints: 24, label: "E" },
  { minPoints: 28, label: "D" },
  { minPoints: 32, label: "C" },
  { minPoints: 36, label: "B" },
  { minPoints: 40, label: "A" },
  { minPoints: 45, label: "A+" },
  { minPoints: 50, label: "A++" }
];

export function parseStrengthTiersJson(raw: Prisma.JsonValue | null | undefined): StrengthTier[] {
  if (raw == null) return DEFAULT_STRENGTH_TIERS;
  if (!Array.isArray(raw)) return DEFAULT_STRENGTH_TIERS;
  const out: StrengthTier[] = [];
  for (const row of raw) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const o = row as Record<string, unknown>;
      const min = o.minPoints;
      const label = o.label;
      if (typeof min === "number" && Number.isFinite(min) && typeof label === "string" && label.trim()) {
        out.push({ minPoints: min, label: label.trim() });
      }
    }
  }
  if (!out.length) return DEFAULT_STRENGTH_TIERS;
  return out.sort((a, b) => a.minPoints - b.minPoints);
}

export function resolveStrengthLabel(points: number, tiers: StrengthTier[]): string {
  const sorted = [...tiers].sort((a, b) => a.minPoints - b.minPoints);
  let label = sorted[0]?.label ?? "?";
  for (const t of sorted) {
    if (points + 1e-9 >= t.minPoints) label = t.label;
  }
  return label;
}

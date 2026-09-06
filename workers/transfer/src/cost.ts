/**
 * Shared R2 cost estimate helpers (Worker + browser).
 * Rates mirror Cloudflare R2 Standard pricing (free tier aware).
 */

export const MAX_BYTES = 15 * 1024 * 1024 * 1024; // 15 GiB
export const RETENTION_HOURS = 24;
export const PART_SIZE = 32 * 1024 * 1024; // 32 MiB (under Workers body limit)
export const FREE_STORAGE_GB_MONTH = 10;
export const FREE_CLASS_A = 1_000_000;
export const STORAGE_USD_PER_GB_MONTH = 0.015;
export const CLASS_A_USD_PER_MILLION = 4.5;

export type CostEstimate = {
  sizeBytes: number;
  sizeGiB: number;
  gbMonth: number;
  classAOps: number;
  storageUsd: number;
  classAUsd: number;
  totalUsd: number;
  withinFreeStorage: boolean;
  withinFreeClassA: boolean;
  withinFreeBudget: boolean;
  warnings: string[];
};

export function partCountForSize(sizeBytes: number, partSize = PART_SIZE): number {
  if (sizeBytes <= 0) return 0;
  return Math.ceil(sizeBytes / partSize);
}

export function estimateR2Cost(sizeBytes: number, partSize = PART_SIZE): CostEstimate {
  const sizeGiB = sizeBytes / (1024 * 1024 * 1024);
  const gbMonth = sizeGiB * (RETENTION_HOURS / 24 / 30);
  const parts = partCountForSize(sizeBytes, partSize);
  const classAOps = parts === 0 ? 0 : 1 + parts + 1;
  const billableStorage = Math.max(0, gbMonth - FREE_STORAGE_GB_MONTH);
  const billableClassA = Math.max(0, classAOps - FREE_CLASS_A);
  const storageUsd = billableStorage * STORAGE_USD_PER_GB_MONTH;
  const classAUsd = (billableClassA / 1_000_000) * CLASS_A_USD_PER_MILLION;
  const withinFreeStorage = gbMonth <= FREE_STORAGE_GB_MONTH;
  const withinFreeClassA = classAOps <= FREE_CLASS_A;
  const warnings: string[] = [];
  if (sizeBytes > MAX_BYTES) {
    warnings.push(`上限 ${MAX_BYTES / 1024 ** 3} GiB を超えています`);
  }
  if (!withinFreeStorage) {
    warnings.push("このアップロード単体で R2 無料保管枠（10 GB-month）を超える見込みです");
  }
  if (sizeGiB > 10) {
    warnings.push(
      "保管中の瞬間容量が 10 GiB を超えます。月平均 GB-month は小さくても、他用途と併用する場合は枠に注意してください",
    );
  }
  return {
    sizeBytes,
    sizeGiB,
    gbMonth,
    classAOps,
    storageUsd,
    classAUsd,
    totalUsd: storageUsd + classAUsd,
    withinFreeStorage,
    withinFreeClassA,
    withinFreeBudget: withinFreeStorage && withinFreeClassA,
    warnings,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 || i === 0 ? 1 : 2)} ${units[i]}`;
}

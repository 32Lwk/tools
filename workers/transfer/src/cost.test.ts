import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateR2Cost,
  FREE_STORAGE_BYTES,
  MAX_BYTES,
  partCountForSize,
  PART_SIZE,
} from "./cost.ts";

describe("estimateR2Cost", () => {
  it("caps at R2 free storage (10 GiB) and stays within free GB-month for 1 day", () => {
    assert.equal(MAX_BYTES, FREE_STORAGE_BYTES);
    const e = estimateR2Cost(MAX_BYTES);
    assert.ok(e.gbMonth < 1);
    assert.equal(e.withinFreeStorage, true);
    assert.equal(e.withinFreeBudget, true);
    assert.equal(e.warnings.length, 0);
  });

  it("warns when over the concurrent free-tier cap", () => {
    const e = estimateR2Cost(MAX_BYTES + 1);
    assert.ok(e.warnings.some((w) => w.includes("10 GiB")));
  });

  it("counts multipart Class A ops", () => {
    const size = PART_SIZE * 3 + 1;
    const e = estimateR2Cost(size);
    assert.equal(partCountForSize(size), 4);
    assert.equal(e.classAOps, 6);
  });
});

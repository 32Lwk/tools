import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateR2Cost, MAX_BYTES, partCountForSize, PART_SIZE } from "./cost.ts";

describe("estimateR2Cost", () => {
  it("treats a 15 GiB × 1 day object as within free GB-month", () => {
    const e = estimateR2Cost(MAX_BYTES);
    assert.ok(e.gbMonth < 1);
    assert.equal(e.withinFreeStorage, true);
    assert.equal(e.withinFreeBudget, true);
    assert.ok(e.warnings.some((w) => w.includes("10 GiB")));
  });

  it("counts multipart Class A ops", () => {
    const size = PART_SIZE * 3 + 1;
    const e = estimateR2Cost(size);
    assert.equal(partCountForSize(size), 4);
    assert.equal(e.classAOps, 6);
  });
});

import { describe, expect, it } from "vitest";
import { INSIGHT_FIELDS } from "../constants.js";

describe("INSIGHT_FIELDS", () => {
  it("does not include unique_impressions", () => {
    expect(INSIGHT_FIELDS.split(",")).not.toContain("unique_impressions");
  });
});

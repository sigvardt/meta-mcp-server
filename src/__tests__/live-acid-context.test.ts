import { describe, expect, it } from "vitest";
import { selectAcidInstagramAccount } from "../../scripts/live-acid-test.mjs";

const selectInstagramAccount = selectAcidInstagramAccount as (params: {
  pageScopedAccount?: Record<string, unknown>;
  igAccounts?: Array<Record<string, unknown>>;
  pageId: string;
  businessInstagramAccountIds: Set<string>;
}) => Record<string, unknown>;

describe("live acid Instagram context selection", () => {
  it("prefers the selected page's Instagram account over token-wide business accounts", () => {
    const selected = selectInstagramAccount({
      pageScopedAccount: { id: "17841448787088534", username: "dynamicretail" },
      pageId: "107926151566414",
      businessInstagramAccountIds: new Set(["17841448787088534"]),
      igAccounts: [
        { id: "17841404215711093", page_id: "token-wide-page", username: "other" },
        { id: "17841448787088534", page_id: "107926151566414", username: "dynamicretail" },
      ],
    });

    expect(selected.id).toBe("17841448787088534");
  });

  it("falls back to the allowlisted business Instagram account before page-linked token-wide matches", () => {
    const selected = selectInstagramAccount({
      pageScopedAccount: { id: "17841404215711093", username: "wrongpage" },
      pageId: "107926151566414",
      businessInstagramAccountIds: new Set(["17841448787088534"]),
      igAccounts: [
        { id: "17841404215711093", page_id: "107926151566414", username: "tokenwide" },
        { id: "17841448787088534", page_id: "dynamic-page", username: "dynamicretail" },
      ],
    });

    expect(selected.id).toBe("17841448787088534");
  });
});

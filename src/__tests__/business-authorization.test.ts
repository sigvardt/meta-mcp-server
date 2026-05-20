import { afterEach, describe, expect, it, vi } from "vitest";
import { makeGraphError } from "./_fixtures.js";
import {
  BusinessAuthorizationError,
  BusinessAuthorizationService,
  BYPASS_PATHS,
} from "../services/business-authorization.js";

type BootstrapClient = Parameters<BusinessAuthorizationService["bootstrap"]>[0];
type GraphResource = {
  id?: string | number;
  instagram_business_account?: { id?: string } | null;
};
type GraphEdgeResponse = {
  data?: GraphResource[];
  paging?: {
    cursors?: {
      after?: string;
    };
  };
};

const DEFAULT_BUSINESS_ID = "833812607571849";

const successfulBootstrapEdges: Record<string, GraphResource[]> = {
  owned_ad_accounts: [{ id: "ad1" }, { id: "ad2" }],
  client_ad_accounts: [{ id: "client-ad1" }],
  owned_pages: [{ id: "page1", instagram_business_account: { id: "ig-from-page1" } }],
  client_pages: [{ id: "client-page1" }],
  owned_instagram_accounts: [{ id: "owned-ig1" }],
  adspixels: [{ id: "ad-pixel1" }],
  owned_pixels: [{ id: "owned-pixel1" }],
  owned_product_catalogs: [{ id: "owned-catalog1" }],
  client_product_catalogs: [{ id: "client-catalog1" }],
  system_users: [{ id: "system-user1" }],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("BusinessAuthorizationService", () => {
  it("allows all resource IDs when META_ALLOWED_BUSINESS_IDS is unset", () => {
    vi.stubEnv("META_ALLOWED_BUSINESS_IDS", undefined);

    const service = new BusinessAuthorizationService();

    expect(service.isAllowed(DEFAULT_BUSINESS_ID)).toBe(true);
    expect(service.isAllowed("000000")).toBe(true);
    expect(service.getSnapshot()).toEqual({ all: ["*"] });
    expect(() => service.assertPathAllowed("/000000/feed", {})).not.toThrow();
  });

  it("skips bootstrap when META_ALLOWED_BUSINESS_IDS is unset", async () => {
    vi.stubEnv("META_ALLOWED_BUSINESS_IDS", undefined);
    const service = new BusinessAuthorizationService();
    const client = createBootstrapClient(successfulBootstrapEdges);

    await service.bootstrap(client);

    expect(client.getRaw).not.toHaveBeenCalled();
  });

  it("uses META_ALLOWED_BUSINESS_IDS as a replacement seed list", () => {
    vi.stubEnv("META_ALLOWED_BUSINESS_IDS", "111,222,333");

    const service = new BusinessAuthorizationService();

    expect(service.isAllowed("111")).toBe(true);
    expect(service.isAllowed("222")).toBe(true);
    expect(service.isAllowed("333")).toBe(true);
    expect(service.isAllowed(DEFAULT_BUSINESS_ID)).toBe(false);
  });

  it("allows bypass path /me", () => {
    const service = serviceWithEmptyAllowlistEnv();

    expect(() => service.assertPathAllowed("/me", {})).not.toThrow();
  });

  it("allows bypass path /me/accounts", () => {
    const service = serviceWithEmptyAllowlistEnv();

    expect(() => service.assertPathAllowed("/me/accounts", {})).not.toThrow();
  });

  it("allows bypass path /me/adaccounts", () => {
    const service = serviceWithEmptyAllowlistEnv();

    expect(() => service.assertPathAllowed("/me/adaccounts", {})).not.toThrow();
  });

  it("allows bypass path /me/businesses", () => {
    const service = serviceWithEmptyAllowlistEnv();

    expect(() => service.assertPathAllowed("/me/businesses", {})).not.toThrow();
  });

  it("allows bypass path /me/permissions", () => {
    const service = serviceWithEmptyAllowlistEnv();

    expect(() => service.assertPathAllowed("/me/permissions", {})).not.toThrow();
  });

  it("allows bypass path /search with params", () => {
    const service = serviceWithEmptyAllowlistEnv();

    expect(() => service.assertPathAllowed("/search", { q: "coffee", type: "page" })).not.toThrow();
  });

  it("allows bypass path /debug_token", () => {
    const service = serviceWithEmptyAllowlistEnv();

    expect(() => service.assertPathAllowed("/debug_token", {})).not.toThrow();
  });

  it("allows bypass path /oauth/", () => {
    const service = serviceWithEmptyAllowlistEnv();

    expect(() => service.assertPathAllowed("/oauth/access_token", { code: "abc" })).not.toThrow();
  });

  it("keeps explicit bypass coverage in sync with BYPASS_PATHS", () => {
    expect(BYPASS_PATHS).toHaveLength(8);
  });

  it("normalizes version prefixes before bypass matching", () => {
    const service = serviceWithEmptyAllowlistEnv();

    expect(() => service.assertPathAllowed("/v21.0/me/accounts", {})).not.toThrow();
  });

  it("throws BusinessAuthorizationError for denied non-bypass path IDs", () => {
    vi.stubEnv("META_ALLOWED_BUSINESS_IDS", "123456");
    const service = new BusinessAuthorizationService();
    const assertDeniedPath = () => service.assertPathAllowed("/999999999/feed", {});

    expect(assertDeniedPath).toThrow(BusinessAuthorizationError);
    expect(assertDeniedPath).toThrow("999999999");
    expect(assertDeniedPath).toThrow("META_ALLOWED_BUSINESS_IDS");
  });

  it("allows non-bypass path IDs added explicitly", () => {
    vi.stubEnv("META_ALLOWED_BUSINESS_IDS", "111");
    const service = new BusinessAuthorizationService();

    service.addAllowed("page", "123456");

    expect(() => service.assertPathAllowed("/123456/feed", {})).not.toThrow();
  });

  it("denies an entire batch when any ids query parameter entry is denied", () => {
    vi.stubEnv("META_ALLOWED_BUSINESS_IDS", "111");
    const service = new BusinessAuthorizationService();
    service.addAllowed("page", "ALLOWED");
    const assertBatch = () => service.assertPathAllowed("/feed", { ids: "ALLOWED,DENIED" });

    expect(assertBatch).toThrow(BusinessAuthorizationError);
    expect(assertBatch).toThrow("DENIED");
  });

  it("normalizes act_ prefixes before allowlist lookup", () => {
    vi.stubEnv("META_ALLOWED_BUSINESS_IDS", "111");
    const service = new BusinessAuthorizationService();

    service.addAllowed("ad_account", "1234567");

    expect(() => service.assertPathAllowed("/act_1234567/campaigns", {})).not.toThrow();
  });

  it("allows all resource IDs when META_ALLOWED_BUSINESS_IDS is empty", () => {
    vi.stubEnv("META_ALLOWED_BUSINESS_IDS", "");
    const service = new BusinessAuthorizationService();

    expect(service.isAllowed(DEFAULT_BUSINESS_ID)).toBe(true);
    expect(service.isAllowed("000000")).toBe(true);
    expect(() => service.assertPathAllowed("/000000/feed", {})).not.toThrow();
  });

  it("bootstraps IDs from successful business edges", async () => {
    vi.stubEnv("META_ALLOWED_BUSINESS_IDS", DEFAULT_BUSINESS_ID);
    const service = new BusinessAuthorizationService();
    const client = createBootstrapClient(successfulBootstrapEdges);

    await service.bootstrap(client);

    expect(service.isAllowed("ad1")).toBe(true);
    expect(service.isAllowed("ad2")).toBe(true);
    expect(service.isAllowed("page1")).toBe(true);
    expect(service.isAllowed("ig-from-page1")).toBe(true);
  });

  it("continues bootstrap after unavailable 4xx edges and keeps successful IDs", async () => {
    vi.stubEnv("META_ALLOWED_BUSINESS_IDS", DEFAULT_BUSINESS_ID);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new BusinessAuthorizationService();
    const client = createBootstrapClient(successfulBootstrapEdges, {
      client_pages: makeHttpError(404),
    });

    await expect(service.bootstrap(client)).resolves.toBeUndefined();

    expect(service.isAllowed("ad1")).toBe(true);
    expect(service.isAllowed("page1")).toBe(true);
    expect(service.isAllowed("client-page1")).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("HTTP 404"));
  });

  it("rejects bootstrap in fail-closed mode after a 5xx edge failure", async () => {
    vi.stubEnv("META_ALLOWED_BUSINESS_IDS", DEFAULT_BUSINESS_ID);
    vi.stubEnv("META_AUTH_BOOTSTRAP_MODE", undefined);
    const service = new BusinessAuthorizationService();
    const client = createBootstrapClient(successfulBootstrapEdges, {
      client_ad_accounts: makeHttpError(500),
    });

    await expect(service.bootstrap(client)).rejects.toThrow("Business authorization bootstrap failed");
    expect(service.isAllowed(DEFAULT_BUSINESS_ID)).toBe(true);
    expect(service.isAllowed("ad1")).toBe(false);
  });

  it("resolves bootstrap in warn mode after a 5xx edge failure and logs to stderr", async () => {
    vi.stubEnv("META_ALLOWED_BUSINESS_IDS", DEFAULT_BUSINESS_ID);
    vi.stubEnv("META_AUTH_BOOTSTRAP_MODE", "warn");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new BusinessAuthorizationService();
    const client = createBootstrapClient(successfulBootstrapEdges, {
      client_ad_accounts: makeHttpError(500),
    });

    await expect(service.bootstrap(client)).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"));
    expect(service.isAllowed(DEFAULT_BUSINESS_ID)).toBe(true);
    expect(service.isAllowed("ad1")).toBe(false);
  });

  it.skip("waits for an in-flight bootstrap before concurrent path assertions", async () => {
    // Current T1 API has synchronous assertPathAllowed() and no bootstrapPromise hook to await.
  });
});

function serviceWithEmptyAllowlistEnv(): BusinessAuthorizationService {
  vi.stubEnv("META_ALLOWED_BUSINESS_IDS", "");
  return new BusinessAuthorizationService();
}

function createBootstrapClient(
  edgeData: Record<string, GraphResource[]>,
  edgeFailures: Record<string, Error> = {}
): BootstrapClient {
  const getRaw = vi.fn(async (path: string): Promise<GraphEdgeResponse> => {
    const edge = path.slice(path.lastIndexOf("/") + 1);
    const failure = edgeFailures[edge];
    if (failure) throw failure;
    return { data: edgeData[edge] ?? [] };
  });

  return { getRaw: getRaw as unknown as BootstrapClient["getRaw"] };
}

function makeHttpError(status: number): Error {
  const error = makeGraphError(100, undefined, `HTTP ${status}`);
  if (error.response) {
    error.response.status = status;
    error.response.statusText = status === 404 ? "Not Found" : "Internal Server Error";
  }
  return error;
}

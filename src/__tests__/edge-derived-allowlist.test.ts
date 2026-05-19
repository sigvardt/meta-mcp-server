import { afterEach, describe, expect, it, vi } from "vitest";
import { GRAPH_API_BASE } from "../constants.js";
import { MetaApiClient } from "../services/api.js";
import {
  BusinessAuthorizationService,
  EDGE_CHILD_TYPE_MAP,
  inferEdgeChildType,
} from "../services/business-authorization.js";
import { mockAxios, mockSuccess } from "./_fixtures.js";

vi.mock("axios");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("edge-derived allowlist propagation", () => {
  it("infers child resource types from normalized Graph edge paths", () => {
    expect(inferEdgeChildType(`${GRAPH_API_BASE}/act_123/campaigns?limit=5`)).toBe(
      "ad_campaign"
    );
    expect(inferEdgeChildType("/v21.0/123/adsets")).toBe("ad_adset");
    expect(inferEdgeChildType("/123/feed")).toBe("post");
    expect(inferEdgeChildType("/ig_hashtag_search")).toBe("instagram_hashtag");
    expect(inferEdgeChildType("/123/products")).toBe("product");
    expect(inferEdgeChildType("/me/accounts")).toBeNull();
    expect(inferEdgeChildType("/123?fields=id,parent_id")).toBeNull();
    expect(EDGE_CHILD_TYPE_MAP.length).toBeGreaterThanOrEqual(22);
  });

  it("does not promote token-scoped page discovery results", async () => {
    const state = mockAxios();
    const mockedGet = vi.mocked(state.axiosInstance.get);
    const { client, authService } = createClientWithAuth();
    mockedGet.mockResolvedValueOnce(
      mockSuccess({ data: [{ id: "1555552638089971" }, { id: "999000111222333" }] }) as never
    );

    await client.get("/me/accounts", { fields: "id", limit: 2 });

    expect(authService.isAllowed("1555552638089971")).toBe(false);
    expect(authService.isAllowed("999000111222333")).toBe(false);
    expect(mockedGet).toHaveBeenCalledWith(`${GRAPH_API_BASE}/me/accounts`, {
      params: { access_token: "userToken", fields: "id", limit: 2 },
      timeout: 30000,
    });
  });

  it("promotes list-edge data IDs after a successful get call", async () => {
    const state = mockAxios();
    const mockedGet = vi.mocked(state.axiosInstance.get);
    const { client, authService } = createClientWithAuth();
    authService.addAllowed("ad_account", "123");
    mockedGet.mockResolvedValueOnce(
      mockSuccess({
        data: [{ id: "23850198464860229" }, { id: "campaign-alpha" }, { name: "missing id" }],
      }) as never
    );

    await client.get("/act_123/campaigns", { fields: "id", limit: 3 });

    expect(authService.isAllowed("23850198464860229")).toBe(true);
    expect(authService.isAllowed("campaign-alpha")).toBe(true);
    expect(authService.isAllowed("missing id")).toBe(false);
    expect(mockedGet).toHaveBeenCalledWith(`${GRAPH_API_BASE}/act_123/campaigns`, {
      params: { access_token: "userToken", fields: "id", limit: 3 },
      timeout: 30000,
    });
  });

  it("promotes page-token feed IDs after a successful getWithToken call", async () => {
    const state = mockAxios();
    const mockedGet = vi.mocked(state.axiosInstance.get);
    const { client, authService } = createClientWithAuth();
    authService.addAllowed("page", "123");
    mockedGet.mockResolvedValueOnce(mockSuccess({ data: [{ id: "456" }] }) as never);

    await client.getWithToken("/123/feed", "pageToken", { fields: "id", limit: 1 });

    expect(authService.isAllowed("456")).toBe(true);
    expect(mockedGet).toHaveBeenCalledWith(`${GRAPH_API_BASE}/123/feed`, {
      params: { access_token: "pageToken", fields: "id", limit: 1 },
      timeout: 30000,
    });
  });

  it("does not promote IDs from bootstrap-only getRaw responses", async () => {
    const state = mockAxios();
    const mockedGet = vi.mocked(state.axiosInstance.get);
    const { client, authService } = createClientWithAuth();
    mockedGet.mockResolvedValueOnce(mockSuccess({ data: [{ id: "23850198464860229" }] }) as never);

    await client.getRaw("/act_123/campaigns", { fields: "id" });

    expect(authService.isAllowed("23850198464860229")).toBe(false);
  });

  it("tolerates keyed batched edge responses and promotes keyed item IDs", async () => {
    const state = mockAxios();
    const mockedGet = vi.mocked(state.axiosInstance.get);
    const { client, authService } = createClientWithAuth();
    authService.addAllowed("page", "123");
    mockedGet.mockResolvedValueOnce(
      mockSuccess({
        first: { id: "456" },
        second: { id: 789 },
        paging: { cursors: { after: "cursor" } },
      }) as never
    );

    await client.get("/123/posts", { fields: "id" });

    expect(authService.isAllowed("456")).toBe(true);
    expect(authService.isAllowed("789")).toBe(true);
  });

  it("propagates hashtag IDs and media IDs across the hashtag search flow", async () => {
    const state = mockAxios();
    const mockedGet = vi.mocked(state.axiosInstance.get);
    const { client, authService } = createClientWithAuth();
    authService.addAllowed("instagram_account", "17841499999999999");
    mockedGet
      .mockResolvedValueOnce(mockSuccess({ data: [{ id: "17841562438105667" }] }) as never)
      .mockResolvedValueOnce(mockSuccess({ data: [{ id: "18092551279314166" }] }) as never);

    await client.get("/ig_hashtag_search", {
      user_id: "17841499999999999",
      q: "cats",
      fields: "id,name",
    });
    await client.get("/17841562438105667/top_media", {
      user_id: "17841499999999999",
      fields: "id,media_type",
      limit: 1,
    });

    expect(authService.isAllowed("17841562438105667")).toBe(true);
    expect(authService.isAllowed("18092551279314166")).toBe(true);
  });

  it("promotes single-object responses only when fields identify the child type", async () => {
    const state = mockAxios();
    const mockedGet = vi.mocked(state.axiosInstance.get);
    const { client, authService } = createClientWithAuth();
    authService.addAllowed("unknown", "18092551279314166");
    mockedGet.mockResolvedValueOnce(
      mockSuccess({ id: "18092551279314166", parent_id: "parent", media_type: "IMAGE" }) as never
    );

    await client.get("/18092551279314166", { fields: "id,parent_id,media_type" });

    expect(authService.getSnapshot().instagram_media).toContain("18092551279314166");
  });
});

function createClientWithAuth(): {
  client: MetaApiClient;
  authService: BusinessAuthorizationService;
} {
  vi.stubEnv("META_ALLOWED_BUSINESS_IDS", "1");
  const authService = new BusinessAuthorizationService();
  const client = new MetaApiClient("userToken");
  client.attachAuthService(authService);
  return { client, authService };
}

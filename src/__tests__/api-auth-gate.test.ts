import axios, { type AxiosResponse } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GRAPH_API_BASE } from "../constants.js";
import { MetaApiClient } from "../services/api.js";
import {
  BusinessAuthorizationError,
  BusinessAuthorizationService,
} from "../services/business-authorization.js";
import { errorResult, handleApiError } from "../services/utils.js";

vi.mock("axios");

type MockAuthService = BusinessAuthorizationService & {
  assertPathAllowed: ReturnType<typeof vi.fn>;
};

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: "OK",
    headers: {},
    config: {},
  } as AxiosResponse<T>;
}

function mockAuthService(error?: BusinessAuthorizationError): MockAuthService {
  return {
    assertPathAllowed: vi.fn(() => {
      if (error) throw error;
    }),
  } as unknown as MockAuthService;
}

describe("MetaApiClient business authorization gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws BusinessAuthorizationError before axios for denied get calls", async () => {
    const denied = new BusinessAuthorizationError("denied resource");
    const authService = mockAuthService(denied);
    const client = new MetaApiClient("userToken");
    client.attachAuthService(authService);

    await expect(client.get("/123/feed", {})).rejects.toBe(denied);

    expect(authService.assertPathAllowed).toHaveBeenCalledWith("/123/feed", {});
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("allows get calls to proceed to axios when the auth service allows them", async () => {
    const authService = mockAuthService();
    const client = new MetaApiClient("userToken");
    const mockedGet = vi.mocked(axios.get);
    client.attachAuthService(authService);
    mockedGet.mockResolvedValueOnce(axiosResponse({ id: "123" }));

    const result = await client.get<{ id: string }>("/123/feed", { fields: "id" });

    expect(result).toEqual({ id: "123" });
    expect(authService.assertPathAllowed).toHaveBeenCalledWith("/123/feed", { fields: "id" });
    expect(mockedGet).toHaveBeenCalledWith(`${GRAPH_API_BASE}/123/feed`, {
      params: { access_token: "userToken", fields: "id" },
      timeout: 30000,
    });
  });

  it("throws BusinessAuthorizationError before axios for denied post calls", async () => {
    const denied = new BusinessAuthorizationError("denied resource");
    const authService = mockAuthService(denied);
    const client = new MetaApiClient("userToken");
    client.attachAuthService(authService);

    await expect(client.post("/123/feed", { message: "test" })).rejects.toBe(denied);

    expect(authService.assertPathAllowed).toHaveBeenCalledWith("/123/feed", { message: "test" });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("does not call the auth service from bootstrap-only getRaw", async () => {
    const denied = new BusinessAuthorizationError("denied resource");
    const authService = mockAuthService(denied);
    const client = new MetaApiClient("userToken");
    const mockedGet = vi.mocked(axios.get);
    client.attachAuthService(authService);
    mockedGet.mockResolvedValueOnce(axiosResponse({ id: "123" }));

    const result = await client.getRaw<{ id: string }>("/123/feed", {});

    expect(result).toEqual({ id: "123" });
    expect(authService.assertPathAllowed).not.toHaveBeenCalled();
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("lets bypass paths proceed through a real auth service", async () => {
    const authService = new BusinessAuthorizationService();
    const client = new MetaApiClient("userToken");
    const mockedGet = vi.mocked(axios.get);
    client.attachAuthService(authService);
    mockedGet.mockResolvedValueOnce(axiosResponse({ data: [] }));

    const result = await client.get<{ data: unknown[] }>("/me/accounts", {});

    expect(result).toEqual({ data: [] });
    expect(mockedGet).toHaveBeenCalledWith(`${GRAPH_API_BASE}/me/accounts`, {
      params: { access_token: "userToken" },
      timeout: 30000,
    });
  });

  it("formats BusinessAuthorizationError as a structured MCP denial", () => {
    const error = new BusinessAuthorizationError("denied resource");

    expect(handleApiError(error)).toBe("Error [BUSINESS_AUTH_DENIED]: denied resource");
    expect(errorResult(error)).toEqual({
      content: [{ type: "text", text: "Error [BUSINESS_AUTH_DENIED]: denied resource" }],
      structuredContent: { code: "BUSINESS_AUTH_DENIED", message: "denied resource" },
      isError: true,
    });
  });

  it("does not tell users to regenerate tokens for page-owned content token-context errors", () => {
    const error = {
      metaError: {
        code: 190,
        error_subcode: 2069032,
        message: "Access token is invalid or expired",
      },
    };

    const message = handleApiError(error);

    expect(message).toContain("Page-owned content");
    expect(message).toContain("meta_list_pages");
    expect(message).not.toContain("Generate a new long-lived token");
  });

  it("translates Meta's ad-account owner permission text into not-found-or-no-access guidance", () => {
    const error = {
      metaError: {
        code: 200,
        message: "Ad account owner has NOT grant ads_management permission",
      },
    };

    const message = handleApiError(error);

    expect(message).toContain("Ad account does not exist or you do not have access");
    expect(message).toContain("meta_list_ad_accounts");
    expect(message).not.toContain("regenerate your token");
  });
});

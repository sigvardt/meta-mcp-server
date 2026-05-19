import axios, { type AxiosError, type AxiosResponse } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRAPH_API_BASE } from "../constants.js";
import { MetaApiClient } from "../services/api.js";

vi.mock("axios");

type MetaErrorResponse = {
  error: {
    code: number;
    error_subcode?: number;
    message: string;
  };
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

function graphError(code: number, subcode?: number): AxiosError<MetaErrorResponse> {
  const error = new Error("Request failed") as AxiosError<MetaErrorResponse>;
  error.response = axiosResponse({
    error: {
      code,
      ...(subcode === undefined ? {} : { error_subcode: subcode }),
      message: "Graph API error",
    },
  });
  return error;
}

describe("MetaApiClient page-token refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes a cached page token and retries getWithToken once", async () => {
    const client = new MetaApiClient("userToken");
    client.cachePageToken("123", "expiredToken");
    const expiredPageToken = graphError(190, 2069032);
    const mockedGet = vi.mocked(axios.get);
    mockedGet
      .mockRejectedValueOnce(expiredPageToken)
      .mockResolvedValueOnce(axiosResponse({ access_token: "freshToken" }))
      .mockResolvedValueOnce(axiosResponse({ success: true }));

    const result = await client.getWithToken<{ success: boolean }>("/123/feed", "expiredToken");

    expect(result).toEqual({ success: true });
    expect(client.getPageToken("123")).toBe("freshToken");
    expect(mockedGet).toHaveBeenCalledTimes(3);
    expect(mockedGet.mock.calls[0]).toEqual([
      `${GRAPH_API_BASE}/123/feed`,
      { params: { access_token: "expiredToken" }, timeout: 30000 },
    ]);
    expect(mockedGet.mock.calls[1]).toEqual([
      `${GRAPH_API_BASE}/123`,
      { params: { access_token: "userToken", fields: "access_token" }, timeout: 30000 },
    ]);
    expect(mockedGet.mock.calls[2]).toEqual([
      `${GRAPH_API_BASE}/123/feed`,
      { params: { access_token: "freshToken" }, timeout: 30000 },
    ]);
  });

  it("surfaces the original error when the single retry also fails", async () => {
    const client = new MetaApiClient("userToken");
    client.cachePageToken("123", "expiredToken");
    const originalError = graphError(190, 2069032);
    const retryError = graphError(190, 2069032);
    const mockedGet = vi.mocked(axios.get);
    mockedGet
      .mockRejectedValueOnce(originalError)
      .mockResolvedValueOnce(axiosResponse({ access_token: "freshToken" }))
      .mockRejectedValueOnce(retryError);

    await expect(client.getWithToken("/123/feed", "expiredToken")).rejects.toBe(originalError);

    const feedCalls = mockedGet.mock.calls.filter(
      ([url]) => url === `${GRAPH_API_BASE}/123/feed`
    );
    expect(feedCalls).toHaveLength(2);
    expect(mockedGet).toHaveBeenCalledTimes(3);
  });

  it("does not retry other 190 errors", async () => {
    const client = new MetaApiClient("userToken");
    client.cachePageToken("123", "expiredToken");
    const tokenError = graphError(190);
    const mockedGet = vi.mocked(axios.get);
    mockedGet.mockRejectedValueOnce(tokenError);

    await expect(client.getWithToken("/123/feed", "expiredToken")).rejects.toBe(tokenError);

    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("does not retry 190/2069032 when the token is not cached for the page", async () => {
    const client = new MetaApiClient("userToken");
    client.cachePageToken("123", "cachedToken");
    const expiredPageToken = graphError(190, 2069032);
    const mockedGet = vi.mocked(axios.get);
    mockedGet.mockRejectedValueOnce(expiredPageToken);

    await expect(client.getWithToken("/123/feed", "uncachedToken")).rejects.toBe(expiredPageToken);

    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("rate-limits refresh attempts within the 5s cooldown", async () => {
    vi.useFakeTimers({ now: 0 });
    const client = new MetaApiClient("userToken");
    client.cachePageToken("123", "expiredToken");
    const mockedGet = vi.mocked(axios.get);

    mockedGet
      .mockRejectedValueOnce(graphError(190, 2069032))
      .mockResolvedValueOnce(axiosResponse({ access_token: "freshToken" }))
      .mockResolvedValueOnce(axiosResponse({ success: "first" }));

    await expect(
      client.getWithToken<{ success: string }>("/123/feed", "expiredToken")
    ).resolves.toEqual({ success: "first" });

    const refreshCalls = () =>
      mockedGet.mock.calls.filter(([url]) => url === `${GRAPH_API_BASE}/123`);
    expect(refreshCalls()).toHaveLength(1);
    expect(client.getPageToken("123")).toBe("freshToken");

    const cooldownError = graphError(190, 2069032);
    vi.advanceTimersByTime(1000);
    mockedGet.mockRejectedValueOnce(cooldownError);

    await expect(client.getWithToken("/123/feed", "freshToken")).rejects.toBe(
      cooldownError
    );
    expect(refreshCalls()).toHaveLength(1);

    vi.advanceTimersByTime(5000);
    mockedGet
      .mockRejectedValueOnce(graphError(190, 2069032))
      .mockResolvedValueOnce(axiosResponse({ access_token: "newerToken" }))
      .mockResolvedValueOnce(axiosResponse({ success: "third" }));

    await expect(
      client.getWithToken<{ success: string }>("/123/feed", "freshToken")
    ).resolves.toEqual({ success: "third" });

    expect(refreshCalls()).toHaveLength(2);
    expect(client.getPageToken("123")).toBe("newerToken");
    expect(mockedGet).toHaveBeenCalledTimes(7);
  });
});

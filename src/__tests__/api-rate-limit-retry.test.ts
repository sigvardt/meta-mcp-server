import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRAPH_API_BASE } from "../constants.js";
import { MetaApiClient } from "../services/api.js";
import { isMetaDevRateLimit } from "../services/utils.js";
import { mockAxios, mockSuccess } from "./_fixtures.js";

vi.mock("axios");

const ORIGINAL_PACE_MS = process.env.META_RATE_LIMIT_PACE_MS;
const ORIGINAL_RETRIES = process.env.META_RATE_LIMIT_RETRIES;

function restoreEnv(): void {
  if (ORIGINAL_PACE_MS === undefined) {
    delete process.env.META_RATE_LIMIT_PACE_MS;
  } else {
    process.env.META_RATE_LIMIT_PACE_MS = ORIGINAL_PACE_MS;
  }

  if (ORIGINAL_RETRIES === undefined) {
    delete process.env.META_RATE_LIMIT_RETRIES;
  } else {
    process.env.META_RATE_LIMIT_RETRIES = ORIGINAL_RETRIES;
  }
}

type GraphError = Error & {
  response: {
    data: {
      error: {
        code: number;
        error_subcode?: number;
        message: string;
      };
    };
  };
};

function graphError(code: number, subcode: number | undefined, message: string): GraphError {
  const error = new Error("Request failed with status code 400") as GraphError;
  error.response = {
    data: {
      error: {
        code,
        ...(subcode === undefined ? {} : { error_subcode: subcode }),
        message,
      },
    },
  };
  return error;
}

function rateLimitError(message = "Meta dev-tier rate-limit"): GraphError {
  return graphError(80004, 2446079, message);
}

function appRateLimitError(message = "(#4) Application request limit reached"): GraphError {
  return graphError(4, undefined, message);
}

describe("MetaApiClient rate-limit retry and pacing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    delete process.env.META_RATE_LIMIT_PACE_MS;
    delete process.env.META_RATE_LIMIT_RETRIES;
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries once after a single 80004/2446079 and returns success", async () => {
    const { axiosInstance } = mockAxios();
    const mockedGet = vi.mocked(axiosInstance.get);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mockedGet
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce(mockSuccess({ success: true }));

    const result = clientGet<{ success: boolean }>();

    await vi.advanceTimersByTimeAsync(0);
    expect(mockedGet).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(result).resolves.toEqual({ success: true });

    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(mockedGet).toHaveBeenNthCalledWith(1, `${GRAPH_API_BASE}/me`, {
      params: { access_token: "userToken" },
      timeout: 30000,
    });
    expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 30_000)).toHaveLength(1);
  });

  it("retries twice after two 80004/2446079 responses and returns success", async () => {
    const { axiosInstance } = mockAxios();
    const mockedGet = vi.mocked(axiosInstance.get);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mockedGet
      .mockRejectedValueOnce(rateLimitError("first"))
      .mockRejectedValueOnce(rateLimitError("second"))
      .mockResolvedValueOnce(mockSuccess({ success: true }));

    const result = clientGet<{ success: boolean }>();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual({ success: true });

    expect(mockedGet).toHaveBeenCalledTimes(3);
    expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 30_000)).toHaveLength(1);
    expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 60_000)).toHaveLength(1);
  });

  it("retries once after a code 4 application request limit and returns success", async () => {
    const { axiosInstance } = mockAxios();
    const mockedGet = vi.mocked(axiosInstance.get);
    const graphError = appRateLimitError();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mockedGet
      .mockRejectedValueOnce(graphError)
      .mockResolvedValueOnce(mockSuccess({ success: true }));

    const result = clientGet<{ success: boolean }>();

    await vi.advanceTimersByTimeAsync(0);
    expect(mockedGet).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(result).resolves.toEqual({ success: true });

    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 30_000)).toHaveLength(1);
    expect(isMetaDevRateLimit(graphError)).toBe(true);
    expect(isMetaDevRateLimit(new Error("Error (4): (#4) Application request limit reached"))).toBe(true);
  });

  it("throws the last 80004/2446079 after three retries are exhausted", async () => {
    const { axiosInstance } = mockAxios();
    const mockedGet = vi.mocked(axiosInstance.get);
    const finalError = rateLimitError("final");
    mockedGet
      .mockRejectedValueOnce(rateLimitError("first"))
      .mockRejectedValueOnce(rateLimitError("second"))
      .mockRejectedValueOnce(rateLimitError("third"))
      .mockRejectedValueOnce(finalError);

    const result = clientGet().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(result).resolves.toBe(finalError);
    expect(mockedGet).toHaveBeenCalledTimes(4);
    expect(isMetaDevRateLimit(finalError)).toBe(true);

    const wrappedError = new Error("wrapped") as Error & {
      metaError: { code: number; error_subcode: number };
    };
    wrappedError.metaError = { code: 80004, error_subcode: 2446079 };
    expect(isMetaDevRateLimit(wrappedError)).toBe(true);
    expect(isMetaDevRateLimit(new Error("Error (80004/2446079): too many calls"))).toBe(true);
  });

  it("fast-fails a path after rate-limit retries are exhausted once", async () => {
    const { axiosInstance } = mockAxios();
    const mockedGet = vi.mocked(axiosInstance.get);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const finalError = rateLimitError("final");
    mockedGet
      .mockRejectedValueOnce(rateLimitError("first"))
      .mockRejectedValueOnce(rateLimitError("second"))
      .mockRejectedValueOnce(rateLimitError("third"))
      .mockRejectedValueOnce(finalError)
      .mockResolvedValueOnce(mockSuccess({ success: true }));

    const client = new MetaApiClient("userToken");
    const firstResult = client.get("/me?fields=id").catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(firstResult).resolves.toBe(finalError);
    expect(mockedGet).toHaveBeenCalledTimes(4);

    const startedAt = Date.now();
    await expect(client.get("/me", { fields: "name" })).rejects.toBe(finalError);

    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(mockedGet).toHaveBeenCalledTimes(4);
    expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 30_000)).toHaveLength(1);
    expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 60_000)).toHaveLength(1);
    expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 120_000)).toHaveLength(1);
  });

  it("does not retry non-rate-limit Graph errors", async () => {
    const { axiosInstance } = mockAxios();
    const mockedGet = vi.mocked(axiosInstance.get);
    const invalidParameterError = graphError(100, undefined, "Invalid parameter");
    mockedGet.mockRejectedValueOnce(invalidParameterError);

    await expect(clientGet()).rejects.toBe(invalidParameterError);

    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("does not retry arbitrary code 4 Graph errors without the app-limit message", async () => {
    const { axiosInstance } = mockAxios();
    const mockedGet = vi.mocked(axiosInstance.get);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const arbitraryCode4Error = graphError(4, undefined, "(#4) This API call is not allowed");
    mockedGet.mockRejectedValueOnce(arbitraryCode4Error);

    await expect(clientGet()).rejects.toBe(arbitraryCode4Error);

    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(isMetaDevRateLimit(arbitraryCode4Error)).toBe(false);
    expect(isMetaDevRateLimit(new Error("Error (4): (#4) This API call is not allowed"))).toBe(false);
  });

  it("paces back-to-back calls by the default minimum gap", async () => {
    const { axiosInstance } = mockAxios();
    const mockedGet = vi.mocked(axiosInstance.get);
    const nowSpy = vi.spyOn(Date, "now");
    const startedAt: number[] = [];
    mockedGet.mockImplementation(() => {
      startedAt.push(Date.now());
      return Promise.resolve(mockSuccess({ call: startedAt.length }) as never);
    });

    const client = new MetaApiClient("userToken");
    const first = clientGet<{ call: number }>(client);
    const second = clientGet<{ call: number }>(client);

    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toEqual({ call: 1 });
    expect(mockedGet).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(mockedGet).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toEqual({ call: 2 });

    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(5_000);
    expect(nowSpy).toHaveBeenCalled();
  });

  it("does not pace back-to-back calls when META_RATE_LIMIT_PACE_MS is 0", async () => {
    process.env.META_RATE_LIMIT_PACE_MS = "0";
    const { axiosInstance } = mockAxios();
    const mockedGet = vi.mocked(axiosInstance.get);
    const startedAt: number[] = [];
    mockedGet.mockImplementation(() => {
      startedAt.push(Date.now());
      return Promise.resolve(mockSuccess({ call: startedAt.length }) as never);
    });

    const client = new MetaApiClient("userToken");
    const first = clientGet<{ call: number }>(client);
    const second = clientGet<{ call: number }>(client);

    await vi.advanceTimersByTimeAsync(0);
    await expect(Promise.all([first, second])).resolves.toEqual([{ call: 1 }, { call: 2 }]);

    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(startedAt[1] - startedAt[0]).toBe(0);
  });

  it("does not retry 80004/2446079 when META_RATE_LIMIT_RETRIES is 0", async () => {
    process.env.META_RATE_LIMIT_RETRIES = "0";
    const { axiosInstance } = mockAxios();
    const mockedGet = vi.mocked(axiosInstance.get);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const graphError = rateLimitError();
    mockedGet.mockRejectedValueOnce(graphError);

    await expect(clientGet()).rejects.toBe(graphError);

    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("getRaw does NOT participate in rate-limit retry — single 80004 propagates immediately", async () => {
    const { axiosInstance } = mockAxios();
    const mockedGet = vi.mocked(axiosInstance.get);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const graphError = rateLimitError();
    mockedGet.mockRejectedValueOnce(graphError);

    const client = new MetaApiClient("userToken");
    await expect(client.getRaw("/me/some-edge")).rejects.toBe(graphError);

    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledWith(`${GRAPH_API_BASE}/me/some-edge`, {
      params: { access_token: "userToken" },
      timeout: 30000,
    });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});

function clientGet<T = unknown>(client = new MetaApiClient("userToken")): Promise<T> {
  return client.get<T>("/me");
}

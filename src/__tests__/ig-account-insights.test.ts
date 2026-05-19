import type { AxiosRequestConfig } from "axios";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { MetaApiClient } from "../services/api.js";
import { registerInstagramTools } from "../tools/instagram.js";
import {
  ERR_IG_ACCOUNT_INSIGHTS_METRIC_TYPE_REQUIRED,
  mockAxios,
  mockSuccess,
  TEST_IG_USER_ID,
} from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type AccountInsightsArgs = {
  ig_account_id: string;
  metrics: string[];
  period: "day" | "week" | "days_28" | "month" | "lifetime";
  metric_type?: "time_series" | "total_value";
  response_format: "markdown" | "json";
};

type AccountInsightsHandler = (args: AccountInsightsArgs) => Promise<ToolResult>;
type AxiosState = ReturnType<typeof mockAxios>;

function getAccountInsightsHandler(): AccountInsightsHandler {
  const handlers = new Map<string, unknown>();
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown): void {
      handlers.set(name, handler);
    },
  };

  registerInstagramTools(server as unknown as McpServer, new MetaApiClient("userToken"));

  const handler = handlers.get("meta_get_instagram_account_insights");
  if (typeof handler !== "function") {
    throw new Error("meta_get_instagram_account_insights was not registered");
  }
  return handler as AccountInsightsHandler;
}

function args(overrides: Partial<AccountInsightsArgs>): AccountInsightsArgs {
  return {
    ig_account_id: TEST_IG_USER_ID,
    metrics: ["impressions"],
    period: "day",
    response_format: "json",
    ...overrides,
  };
}

function mockNextInsightsSuccess({ axiosInstance, requests }: AxiosState): void {
  vi.mocked(axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
    requests.push({ method: "get", url, params: config?.params });
    return Promise.resolve(mockSuccess({ data: [] }) as never);
  });
}

function firstParams(requests: AxiosState["requests"]): Record<string, unknown> {
  expect(requests).toHaveLength(1);
  expect(requests[0]?.params).toBeDefined();
  return requests[0]?.params as Record<string, unknown>;
}

describe("meta_get_instagram_account_insights metric_type", () => {
  it("prevents the Meta metric_type-required error by adding total_value for modern metrics", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      const params = config?.params as Record<string, unknown> | undefined;
      if (params?.metric_type !== "total_value") {
        return Promise.reject(ERR_IG_ACCOUNT_INSIGHTS_METRIC_TYPE_REQUIRED);
      }
      return Promise.resolve(mockSuccess({ data: [] }) as never);
    });

    const result = await getAccountInsightsHandler()(args({ metrics: ["accounts_engaged", "likes"] }));

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).not.toContain("Error (100/2108006)");
    expect(firstParams(state.requests).metric_type).toBe("total_value");
  });

  it("auto-detects modern metrics and returns a hint", async () => {
    const state = mockAxios();
    mockNextInsightsSuccess(state);

    const result = await getAccountInsightsHandler()(args({ metrics: ["accounts_engaged", "likes"] }));
    const params = firstParams(state.requests);
    const body = JSON.parse(result.content[0]?.text ?? "{}") as { hint?: string };

    expect(params.metric).toBe("accounts_engaged,likes");
    expect(params.metric_type).toBe("total_value");
    expect(body.hint).toContain("Auto-added metric_type=total_value");
    expect(body.hint).toContain("accounts_engaged, likes");
  });

  it("passes through explicit metric_type for legacy metrics", async () => {
    const state = mockAxios();
    mockNextInsightsSuccess(state);

    await getAccountInsightsHandler()(args({ metrics: ["impressions"], metric_type: "time_series" }));

    expect(firstParams(state.requests).metric_type).toBe("time_series");
  });

  it("fails fast when modern and legacy metric families are mixed", async () => {
    const state = mockAxios();

    const result = await getAccountInsightsHandler()(args({ metrics: ["accounts_engaged", "impressions"] }));
    const text = result.content[0]?.text ?? "";

    expect(state.requests).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(text).toContain("Cannot mix metric families in one call");
    expect(text).toContain("Modern metrics (accounts_engaged) require metric_type=total_value");
    expect(text).toContain("legacy metrics (impressions) require time_series");
    expect(text).toContain("Split into two calls");
  });

  it("does not add metric_type for legacy metrics when it is not needed", async () => {
    const state = mockAxios();
    mockNextInsightsSuccess(state);

    await getAccountInsightsHandler()(args({ metrics: ["impressions"] }));

    expect(firstParams(state.requests)).not.toHaveProperty("metric_type");
  });
});

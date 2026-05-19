import type { AxiosRequestConfig } from "axios";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { PAGE_INSIGHTS_DEFAULT_METRICS } from "../constants.js";
import { MetaApiClient } from "../services/api.js";
import { registerPageTools } from "../tools/pages.js";
import {
  ERR_PAGE_INSIGHTS_INVALID_METRIC,
  mockAxios,
  mockSuccess,
  TEST_PAGE_ID,
} from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type PageInsightsArgs = {
  page_id: string;
  metrics: string[];
  period: "day" | "week" | "days_28" | "month";
  since?: string;
  until?: string;
  response_format: "markdown" | "json";
};

type PageInsightsConfig = {
  inputSchema: {
    parse(value: unknown): PageInsightsArgs;
  };
};

type PageInsightsHandler = (args: PageInsightsArgs) => Promise<ToolResult>;
type AxiosState = ReturnType<typeof mockAxios>;

const LEGACY_PAGE_INSIGHTS_METRICS = [
  "page_impressions",
  "page_impressions_unique",
  "page_impressions_paid",
  "page_impressions_organic",
  "page_engaged_users",
  "page_posts_impressions",
  "page_posts_impressions_unique",
  "page_fan_adds",
  "page_fan_removes",
  "page_consumptions",
] as const;

function getPageInsightsTool(): { config: PageInsightsConfig; handler: PageInsightsHandler } {
  const configs = new Map<string, unknown>();
  const handlers = new Map<string, unknown>();
  const server = {
    registerTool(name: string, config: unknown, handler: unknown): void {
      configs.set(name, config);
      handlers.set(name, handler);
    },
  };
  const client = new MetaApiClient("userToken");
  client.cachePageToken(TEST_PAGE_ID, "pageToken");

  registerPageTools(server as unknown as McpServer, client);

  const config = configs.get("meta_get_page_insights") as PageInsightsConfig | undefined;
  const handler = handlers.get("meta_get_page_insights");
  if (!config || typeof handler !== "function") {
    throw new Error("meta_get_page_insights was not registered");
  }

  return { config, handler: handler as PageInsightsHandler };
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

describe("meta_get_page_insights defaults", () => {
  it("uses the current Page Insights defaults when metrics are omitted", async () => {
    const state = mockAxios();
    mockNextInsightsSuccess(state);
    const { config, handler } = getPageInsightsTool();

    const result = await handler(config.inputSchema.parse({ page_id: TEST_PAGE_ID }));

    expect(result.isError).not.toBe(true);
    const params = firstParams(state.requests);
    const metrics = String(params.metric).split(",");
    expect(params.period).toBe("day");
    expect(metrics).toEqual([...PAGE_INSIGHTS_DEFAULT_METRICS]);
    expect(metrics).not.toEqual(expect.arrayContaining([...LEGACY_PAGE_INSIGHTS_METRICS]));
  });

  it("adds metrics guidance when Meta returns the documented legacy-metric error", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.reject({
        ...ERR_PAGE_INSIGHTS_INVALID_METRIC,
        response: {
          data: {
            error: {
              code: 100,
              message: "(#100) The value must be a valid insights metric",
            },
          },
        },
      });
    });
    const { config, handler } = getPageInsightsTool();

    const result = await handler(
      config.inputSchema.parse({
        page_id: TEST_PAGE_ID,
        metrics: [...LEGACY_PAGE_INSIGHTS_METRICS],
        response_format: "json",
      })
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("(#100) The value must be a valid insights metric");
    expect(result.content[0]?.text).toContain("`metrics` parameter");
    expect(result.content[0]?.text).toContain("Omit `metrics` to use the current defaults");
    expect(firstParams(state.requests).metric).toBe(LEGACY_PAGE_INSIGHTS_METRICS.join(","));
  });
});

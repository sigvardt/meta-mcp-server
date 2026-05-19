import type { AxiosRequestConfig } from "axios";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { POST_INSIGHTS_DEFAULT_METRICS } from "../constants.js";
import { MetaApiClient } from "../services/api.js";
import { registerPageTools } from "../tools/pages.js";
import { mockAxios, mockSuccess, TEST_PAGE_ID } from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type PostInsightsArgs = {
  post_id: string;
  page_id: string;
  metrics: string[];
  response_format: "markdown" | "json";
};

type PostInsightsConfig = {
  inputSchema: {
    parse(value: unknown): PostInsightsArgs;
  };
};

type PostInsightsHandler = (args: PostInsightsArgs) => Promise<ToolResult>;
type AxiosState = ReturnType<typeof mockAxios>;

const TEST_POST_ID = `${TEST_PAGE_ID}_1111111`;

const RETIRED_POST_INSIGHTS_METRICS = [
  "post_impressions",
  "post_impressions_unique",
  "post_impressions_paid",
  "post_impressions_organic",
  "post_engaged_users",
  "post_negative_feedback",
] as const;

function getPostInsightsTool(): { config: PostInsightsConfig; handler: PostInsightsHandler } {
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

  const config = configs.get("meta_get_post_insights") as PostInsightsConfig | undefined;
  const handler = handlers.get("meta_get_post_insights");
  if (!config || typeof handler !== "function") {
    throw new Error("meta_get_post_insights was not registered");
  }

  return { config, handler: handler as PostInsightsHandler };
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

describe("meta_get_post_insights defaults", () => {
  it("uses current Post Insights defaults when metrics are omitted", async () => {
    const state = mockAxios();
    mockNextInsightsSuccess(state);
    const { config, handler } = getPostInsightsTool();

    const result = await handler(config.inputSchema.parse({ post_id: TEST_POST_ID, page_id: TEST_PAGE_ID }));

    expect(result.isError).not.toBe(true);
    const params = firstParams(state.requests);
    const metrics = String(params.metric).split(",");
    expect(metrics).toEqual([...POST_INSIGHTS_DEFAULT_METRICS]);
    expect(metrics).not.toEqual(expect.arrayContaining([...RETIRED_POST_INSIGHTS_METRICS]));
    expect(metrics.some((metric) => metric.startsWith("post_video_"))).toBe(false);
  });
});

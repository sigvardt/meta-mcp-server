import type { AxiosRequestConfig } from "axios";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { PAGE_FAN_DEMOGRAPHICS_DEFAULT_METRICS } from "../constants.js";
import { MetaApiClient } from "../services/api.js";
import { registerPageTools } from "../tools/pages.js";
import { mockAxios, mockSuccess, TEST_PAGE_ID } from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type PageFanDemographicsArgs = {
  page_id: string;
  metrics: string[];
  response_format: "markdown" | "json";
};

type PageFanDemographicsConfig = {
  inputSchema: {
    parse(value: unknown): PageFanDemographicsArgs;
  };
};

type PageFanDemographicsHandler = (args: PageFanDemographicsArgs) => Promise<ToolResult>;
type AxiosState = ReturnType<typeof mockAxios>;

const LEGACY_PAGE_FAN_DEMOGRAPHICS_METRICS = [
  "page_fans_country",
  "page_fans_city",
  "page_fans_locale",
  "page_fans_gender_age",
] as const;

function getPageFanDemographicsTool(): {
  config: PageFanDemographicsConfig;
  handler: PageFanDemographicsHandler;
} {
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

  const config = configs.get("meta_get_page_fan_demographics") as PageFanDemographicsConfig | undefined;
  const handler = handlers.get("meta_get_page_fan_demographics");
  if (!config || typeof handler !== "function") {
    throw new Error("meta_get_page_fan_demographics was not registered");
  }

  return { config, handler: handler as PageFanDemographicsHandler };
}

function mockNextInsightsSuccess({ axiosInstance, requests }: AxiosState): void {
  vi.mocked(axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
    requests.push({ method: "get", url, params: config?.params });
    return Promise.resolve(mockSuccess({ data: [] }) as never);
  });
}

function firstRequest(requests: AxiosState["requests"]): AxiosState["requests"][number] {
  expect(requests).toHaveLength(1);
  expect(requests[0]).toBeDefined();
  return requests[0] as AxiosState["requests"][number];
}

describe("meta_get_page_fan_demographics defaults", () => {
  it("uses current follower demographics defaults when metrics are omitted", async () => {
    const state = mockAxios();
    mockNextInsightsSuccess(state);
    const { config, handler } = getPageFanDemographicsTool();

    const result = await handler(config.inputSchema.parse({ page_id: TEST_PAGE_ID }));

    expect(result.isError).not.toBe(true);
    const request = firstRequest(state.requests);
    const params = request.params as Record<string, unknown>;
    const metrics = String(params.metric).split(",");
    expect(request.url).toContain(`/${TEST_PAGE_ID}/insights`);
    expect(params.period).toBe("lifetime");
    expect(metrics).toEqual([...PAGE_FAN_DEMOGRAPHICS_DEFAULT_METRICS]);
    expect(metrics).toEqual(expect.arrayContaining([...PAGE_FAN_DEMOGRAPHICS_DEFAULT_METRICS]));
    expect(metrics).not.toEqual(expect.arrayContaining([...LEGACY_PAGE_FAN_DEMOGRAPHICS_METRICS]));
  });
});

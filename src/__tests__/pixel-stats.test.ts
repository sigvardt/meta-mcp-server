import type { AxiosRequestConfig } from "axios";
import { describe, expect, it, vi } from "vitest";
import { MetaApiClient } from "../services/api.js";
import { registerAdsTools } from "../tools/ads.js";
import { mockAxios, mockSuccess } from "./_fixtures.js";

vi.mock("axios");

const TEST_PIXEL_ID = "pixel-123";

const VALID_AGGREGATIONS = [
  "browser_type",
  "custom_data_field",
  "device_os",
  "device_type",
  "event",
  "host",
  "match_keys",
  "had_pii",
  "pixel_fire",
  "event_detection_method",
  "url",
  "event_value_count",
  "url_by_rule",
  "event_total_counts",
  "event_source",
  "event_processing_results",
] as const;

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type PixelStatsArgs = {
  pixel_id: string;
  start_time?: string;
  end_time?: string;
  aggregation: (typeof VALID_AGGREGATIONS)[number];
  event?: string;
  response_format: "markdown" | "json";
};

type PixelStatsConfig = {
  inputSchema: {
    parse(value: unknown): PixelStatsArgs;
    safeParse(value: unknown):
      | { success: true; data: PixelStatsArgs }
      | {
          success: false;
          error: {
            issues: Array<{ path: Array<string | number>; message: string }>;
          };
        };
  };
};

type PixelStatsHandler = (args: PixelStatsArgs) => Promise<ToolResult>;

function getPixelStatsTool(): { config: PixelStatsConfig; handler: PixelStatsHandler } {
  const configs = new Map<string, unknown>();
  const handlers = new Map<string, unknown>();
  const server = {
    registerTool(name: string, config: unknown, handler: unknown): void {
      configs.set(name, config);
      handlers.set(name, handler);
    },
  };
  const client = new MetaApiClient("test-token");

  registerAdsTools(server as never, client);

  const config = configs.get("meta_get_pixel_stats") as PixelStatsConfig | undefined;
  const handler = handlers.get("meta_get_pixel_stats");
  if (!config || typeof handler !== "function") {
    throw new Error("meta_get_pixel_stats was not registered");
  }

  return { config, handler: handler as PixelStatsHandler };
}

function mockNextPixelStatsSuccess({ axiosInstance, requests }: ReturnType<typeof mockAxios>): void {
  vi.mocked(axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
    requests.push({ method: "get", url, params: config?.params });
    return Promise.resolve(mockSuccess({ data: [] }) as never);
  });
}

describe("meta_get_pixel_stats aggregation", () => {
  it("rejects device before any axios call", () => {
    const state = mockAxios();
    const { config } = getPixelStatsTool();

    const result = config.inputSchema.safeParse({
      pixel_id: TEST_PIXEL_ID,
      aggregation: "device",
      response_format: "json",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({ path: ["aggregation"] });
    }
    expect(state.requests).toHaveLength(0);
  });

  it("accepts every documented aggregation value", () => {
    const state = mockAxios();
    const { config } = getPixelStatsTool();

    for (const aggregation of VALID_AGGREGATIONS) {
      const result = config.inputSchema.safeParse({
        pixel_id: TEST_PIXEL_ID,
        aggregation,
        response_format: "json",
      });

      expect(result.success).toBe(true);
    }

    expect(state.requests).toHaveLength(0);
  });

  it("passes device_os through to the Graph API request", async () => {
    const state = mockAxios();
    const { config, handler } = getPixelStatsTool();
    mockNextPixelStatsSuccess(state);

    const result = await handler(
      config.inputSchema.parse({
        pixel_id: TEST_PIXEL_ID,
        aggregation: "device_os",
        response_format: "json",
      })
    );

    expect(result.isError).not.toBe(true);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.params).toMatchObject({ aggregation: "device_os" });
  });
});

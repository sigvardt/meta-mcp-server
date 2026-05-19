import type { AxiosRequestConfig } from "axios";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { GRAPH_API_BASE } from "../constants.js";
import { MetaApiClient } from "../services/api.js";
import { registerPageTools } from "../tools/pages.js";
import { documentedErrors, mockAxios, mockSuccess, TEST_PAGE_ID } from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type PageVideosArgs = {
  page_id: string;
  limit: number;
  after?: string;
  response_format: "markdown" | "json";
};

type PageVideosHandlerArgs = PageVideosArgs & {
  include_thumbnails?: boolean;
};

type PageVideosConfig = {
  inputSchema: {
    parse(value: unknown): PageVideosArgs;
  };
};

type PageVideosHandler = (args: PageVideosHandlerArgs) => Promise<ToolResult>;
type AxiosState = ReturnType<typeof mockAxios>;

const DEFAULT_FIELDS = "id,title,description,length,views,created_time,permalink_url,source";
const THUMBNAIL_FIELDS = `${DEFAULT_FIELDS},thumbnails`;

const errorPageVideosLimit = documentedErrors.get("errorPageVideosLimit");
if (!errorPageVideosLimit) {
  throw new Error("Missing errorPageVideosLimit fixture");
}

function getPageVideosTool(): { config: PageVideosConfig; handler: PageVideosHandler } {
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

  const config = configs.get("meta_get_page_videos") as PageVideosConfig | undefined;
  const handler = handlers.get("meta_get_page_videos");
  if (!config || typeof handler !== "function") {
    throw new Error("meta_get_page_videos was not registered");
  }

  return { config, handler: handler as PageVideosHandler };
}

function mockNextPageVideosResponse({ axiosInstance, requests }: AxiosState): void {
  vi.mocked(axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
    requests.push({ method: "get", url, params: config?.params });

    const params = config?.params as Record<string, unknown> | undefined;
    const fields = String(params?.fields ?? "");
    if (fields.includes("thumbnails")) {
      return Promise.reject(errorPageVideosLimit);
    }

    return Promise.resolve(mockSuccess({ data: [] }) as never);
  });
}

function firstRequest(requests: AxiosState["requests"]): AxiosState["requests"][number] {
  expect(requests).toHaveLength(1);
  expect(requests[0]).toBeDefined();
  return requests[0] as AxiosState["requests"][number];
}

describe("meta_get_page_videos", () => {
  it("keeps thumbnails out of the default fields list", async () => {
    const state = mockAxios();
    mockNextPageVideosResponse(state);
    const { config, handler } = getPageVideosTool();

    const result = await handler(config.inputSchema.parse({ page_id: TEST_PAGE_ID, response_format: "json" }));

    expect(result.isError).not.toBe(true);
    const request = firstRequest(state.requests);
    const params = request.params as Record<string, unknown>;
    expect(request.url).toBe(`${GRAPH_API_BASE}/${TEST_PAGE_ID}/videos`);
    expect(params.fields).toBe(DEFAULT_FIELDS);
    expect(String(params.fields)).not.toContain("thumbnails");
  });

  it("adds thumbnails back when explicitly requested", async () => {
    const state = mockAxios();
    mockNextPageVideosResponse(state);
    const { config, handler } = getPageVideosTool();

    const result = await handler({
      ...config.inputSchema.parse({ page_id: TEST_PAGE_ID, response_format: "json" }),
      include_thumbnails: true,
    });

    expect(result.isError).toBe(true);
    const request = firstRequest(state.requests);
    const params = request.params as Record<string, unknown>;
    expect(request.url).toBe(`${GRAPH_API_BASE}/${TEST_PAGE_ID}/videos`);
    expect(params.fields).toBe(THUMBNAIL_FIELDS);
    expect(String(params.fields)).toContain("thumbnails");
  });
});

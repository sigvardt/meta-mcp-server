import type { AxiosRequestConfig } from "axios";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { GRAPH_API_BASE, POST_FIELDS } from "../constants.js";
import { MetaApiClient } from "../services/api.js";
import { registerPageTools } from "../tools/pages.js";
import {
  ERR_PROMOTABLE_POSTS_FIELD_REMOVED,
  TEST_PAGE_ID,
  mockAxios,
  mockSuccess,
} from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type PromotablePostsArgs = {
  page_id: string;
  limit: number;
  after?: string;
  before?: string;
  response_format: "markdown" | "json";
};

type PromotablePostsConfig = {
  inputSchema: {
    parse(value: unknown): PromotablePostsArgs;
  };
};

type PromotablePostsHandler = (args: PromotablePostsArgs) => Promise<ToolResult>;
type AxiosState = ReturnType<typeof mockAxios>;

const PROMOTABLE_POST_FIELDS = `${POST_FIELDS},is_eligible_for_promotion`;

function getPromotablePostsTool(): { config: PromotablePostsConfig; handler: PromotablePostsHandler } {
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

  const config = configs.get("meta_get_promotable_posts") as PromotablePostsConfig | undefined;
  const handler = handlers.get("meta_get_promotable_posts");
  if (!config || typeof handler !== "function") {
    throw new Error("meta_get_promotable_posts was not registered");
  }

  return { config, handler: handler as PromotablePostsHandler };
}

function mockPromotableFeedResponse({ axiosInstance, requests }: AxiosState): void {
  vi.mocked(axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
    requests.push({ method: "get", url, params: config?.params });
    if (url.includes("/promotable_posts")) {
      return Promise.reject(ERR_PROMOTABLE_POSTS_FIELD_REMOVED);
    }

    return Promise.resolve(
      mockSuccess({
        data: [
          {
            id: `${TEST_PAGE_ID}_123`,
            message: "Boostable launch post",
            created_time: "2026-05-19T00:00:00+0000",
            is_eligible_for_promotion: true,
          },
        ],
      }) as never
    );
  });
}

function firstRequest(requests: AxiosState["requests"]): AxiosState["requests"][number] {
  expect(requests).toHaveLength(1);
  expect(requests[0]).toBeDefined();
  return requests[0] as AxiosState["requests"][number];
}

describe("meta_get_promotable_posts", () => {
  it("uses the Page feed eligibility filter instead of the removed promotable_posts edge", async () => {
    const state = mockAxios();
    mockPromotableFeedResponse(state);
    const { config, handler } = getPromotablePostsTool();

    const result = await handler(
      config.inputSchema.parse({
        page_id: TEST_PAGE_ID,
        limit: 7,
        after: "AFTER_CURSOR",
        before: "BEFORE_CURSOR",
        response_format: "json",
      })
    );

    expect(result.isError).not.toBe(true);
    const request = firstRequest(state.requests);
    const params = request.params as Record<string, unknown>;
    expect(request.url).toBe(`${GRAPH_API_BASE}/${TEST_PAGE_ID}/feed`);
    expect(request.url).not.toContain("/promotable_posts");
    expect(params.fields).toBe(PROMOTABLE_POST_FIELDS);
    expect(params.is_eligible_for_promotion).toBe(true);
    expect(params.limit).toBe(7);
    expect(params.after).toBe("AFTER_CURSOR");
    expect(params.before).toBe("BEFORE_CURSOR");
    expect(result.content[0].text).toContain(`${TEST_PAGE_ID}_123`);
  });
});

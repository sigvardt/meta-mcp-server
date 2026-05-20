import type { AxiosRequestConfig } from "axios";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRAPH_API_BASE } from "../constants.js";
import { MetaApiClient } from "../services/api.js";
import { registerPageTools } from "../tools/pages.js";
import { mockAxios, mockSuccess, TEST_PAGE_ID } from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type PostReactionsArgs = {
  post_id: string;
  response_format: "markdown" | "json";
};

type PostReactionsConfig = {
  inputSchema: {
    parse(value: unknown): PostReactionsArgs;
  };
};

type PostReactionsHandler = (args: PostReactionsArgs) => Promise<ToolResult>;
type AxiosState = ReturnType<typeof mockAxios>;

const TEST_POST_ID = `${TEST_PAGE_ID}_1111111`;
const PAGE_TOKEN_FIXTURE = "pageToken";
const USER_TOKEN_FIXTURE = "userToken";
const ORIGINAL_PACE_MS = process.env.META_RATE_LIMIT_PACE_MS;

function restoreEnv(): void {
  if (ORIGINAL_PACE_MS === undefined) {
    delete process.env.META_RATE_LIMIT_PACE_MS;
  } else {
    process.env.META_RATE_LIMIT_PACE_MS = ORIGINAL_PACE_MS;
  }
}

function getPostReactionsTool(): { config: PostReactionsConfig; handler: PostReactionsHandler } {
  const configs = new Map<string, unknown>();
  const handlers = new Map<string, unknown>();
  const server = {
    registerTool(name: string, config: unknown, handler: unknown): void {
      configs.set(name, config);
      handlers.set(name, handler);
    },
  };
  const client = new MetaApiClient(USER_TOKEN_FIXTURE);
  client.cachePageToken(TEST_PAGE_ID, PAGE_TOKEN_FIXTURE);

  registerPageTools(server as unknown as McpServer, client);

  const config = configs.get("meta_get_post_reactions") as PostReactionsConfig | undefined;
  const handler = handlers.get("meta_get_post_reactions");
  if (!config || typeof handler !== "function") {
    throw new Error("meta_get_post_reactions was not registered");
  }

  return { config, handler: handler as PostReactionsHandler };
}

function mockReactionResponses({ axiosInstance, requests }: AxiosState): void {
  vi.mocked(axiosInstance.get).mockImplementation((url: string, config?: AxiosRequestConfig) => {
    requests.push({ method: "get", url, params: config?.params });
    const type = String((config?.params as Record<string, unknown> | undefined)?.type ?? "LIKE");
    const counts: Record<string, number> = {
      LIKE: 11,
      LOVE: 7,
      HAHA: 5,
      WOW: 3,
      SAD: 2,
      ANGRY: 1,
    };

    return Promise.resolve(mockSuccess({ summary: { total_count: counts[type] ?? 0 } }) as never);
  });
}

describe("meta_get_post_reactions", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("uses the cached Page token for Page-owned post IDs", async () => {
    process.env.META_RATE_LIMIT_PACE_MS = "0";
    const state = mockAxios();
    mockReactionResponses(state);
    const { config, handler } = getPostReactionsTool();

    const result = await handler(
      config.inputSchema.parse({
        post_id: TEST_POST_ID,
        response_format: "json",
      })
    );

    expect(result.isError).not.toBe(true);
    expect(state.requests).toHaveLength(6);
    for (const request of state.requests) {
      const params = request.params as Record<string, unknown>;
      expect(request.url).toBe(`${GRAPH_API_BASE}/${TEST_POST_ID}/reactions`);
      expect(params.access_token).toBe(PAGE_TOKEN_FIXTURE);
      expect(params.access_token).not.toBe(USER_TOKEN_FIXTURE);
      expect(params.summary).toBe("total_count");
      expect(params.limit).toBe(0);
    }
    expect(state.requests.map((request) => (request.params as Record<string, unknown>).type)).toEqual([
      "LIKE",
      "LOVE",
      "HAHA",
      "WOW",
      "SAD",
      "ANGRY",
    ]);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
      LIKE: 11,
      LOVE: 7,
      HAHA: 5,
      WOW: 3,
      SAD: 2,
      ANGRY: 1,
    });
  });
});

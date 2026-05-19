import type { AxiosRequestConfig } from "axios";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { GRAPH_API_BASE } from "../constants.js";
import { MetaApiClient } from "../services/api.js";
import { registerInstagramTools } from "../tools/instagram.js";
import { mockAxios, mockSuccess, TEST_IG_USER_ID } from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type HashtagSearchArgs = {
  ig_account_id: string;
  hashtag: string;
  edge?: "top_media" | "recent_media";
  limit?: number;
  response_format: "markdown" | "json";
};

type HashtagSearchHandler = (args: HashtagSearchArgs) => Promise<ToolResult>;

function getHashtagSearchHandler(): HashtagSearchHandler {
  const handlers = new Map<string, unknown>();
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown): void {
      handlers.set(name, handler);
    },
  };

  registerInstagramTools(server as unknown as McpServer, new MetaApiClient("userToken"));

  const handler = handlers.get("meta_search_instagram_hashtag");
  if (typeof handler !== "function") {
    throw new Error("meta_search_instagram_hashtag was not registered");
  }

  return handler as HashtagSearchHandler;
}

describe("meta_search_instagram_hashtag", () => {
  it("keeps hashtag lookup fields narrow and hashtag media fields supported", async () => {
    const state = mockAxios();
    const mockedGet = vi.mocked(state.axiosInstance.get);

    mockedGet
      .mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
        state.requests.push({ method: "get", url, params: config?.params });
        return Promise.resolve(mockSuccess({ data: [{ id: "hashtag-123", name: "cats" }] }) as never);
      })
      .mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
        state.requests.push({ method: "get", url, params: config?.params });
        return Promise.resolve(
          mockSuccess({
            data: [
              {
                id: "media-1",
                media_type: "IMAGE",
                caption: "cats",
                like_count: 12,
                comments_count: 3,
                permalink: "https://example.com/media-1",
              },
            ],
          }) as never
        );
      });

    const result = await getHashtagSearchHandler()({
      ig_account_id: TEST_IG_USER_ID,
      hashtag: "cats",
      edge: "top_media",
      limit: 20,
      response_format: "json",
    });

    expect(result.isError).toBeUndefined();
    expect(state.requests).toHaveLength(2);
    expect(state.requests[0]?.url).toBe(`${GRAPH_API_BASE}/ig_hashtag_search`);

    const firstParams = state.requests[0]?.params as Record<string, unknown>;
    expect(firstParams).toMatchObject({
      access_token: "userToken",
      user_id: TEST_IG_USER_ID,
      q: "cats",
      fields: "id,name",
    });

    expect(state.requests[1]?.url).toBe(`${GRAPH_API_BASE}/hashtag-123/top_media`);

    const secondParams = state.requests[1]?.params as Record<string, unknown>;
    expect(secondParams).toMatchObject({
      access_token: "userToken",
      user_id: TEST_IG_USER_ID,
      limit: 20,
      fields: "id,media_type,media_url,permalink,caption,like_count,comments_count,timestamp",
    });
    expect(String(secondParams.fields)).not.toContain("media_product_type");
    expect(String(secondParams.fields)).not.toContain("thumbnail_url");

    expect(result.content[0]?.text).toContain('"hashtag_id": "hashtag-123"');
  });
});

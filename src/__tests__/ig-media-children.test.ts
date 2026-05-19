import type { AxiosRequestConfig } from "axios";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { GRAPH_API_BASE } from "../constants.js";
import { MetaApiClient } from "../services/api.js";
import { registerInstagramTools } from "../tools/instagram.js";
import {
  ERR_IG_MEDIA_CHILDREN_FIELD_NOT_AVAILABLE,
  mockAxios,
  mockSuccess,
} from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type MediaChildrenArgs = {
  media_id: string;
  response_format: "markdown" | "json";
};

type MediaChildrenHandler = (args: MediaChildrenArgs) => Promise<ToolResult>;

type AxiosState = ReturnType<typeof mockAxios>;

const CHILD_FIELDS = "id,media_type,media_url,permalink,thumbnail_url,timestamp,username";
const TEST_MEDIA_ID = "media-123";

function getMediaChildrenHandler(): MediaChildrenHandler {
  const handlers = new Map<string, unknown>();
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown): void {
      handlers.set(name, handler);
    },
  };

  registerInstagramTools(server as unknown as McpServer, new MetaApiClient("userToken"));

  const handler = handlers.get("meta_get_instagram_media_children");
  if (typeof handler !== "function") {
    throw new Error("meta_get_instagram_media_children was not registered");
  }

  return handler as MediaChildrenHandler;
}

function firstParams(requests: AxiosState["requests"]): Record<string, unknown> {
  expect(requests).toHaveLength(1);
  expect(requests[0]?.params).toBeDefined();
  return requests[0]?.params as Record<string, unknown>;
}

describe("meta_get_instagram_media_children", () => {
  it("requests only carousel-child-safe fields and avoids the Meta 100 error", async () => {
    const state = mockAxios();

    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });

      const params = config?.params as Record<string, unknown> | undefined;
      const fields = String(params?.fields ?? "");
      if (fields.includes("like_count") || fields.includes("comments_count") || fields.includes("caption")) {
        return Promise.reject(ERR_IG_MEDIA_CHILDREN_FIELD_NOT_AVAILABLE);
      }

      return Promise.resolve(
        mockSuccess({
          data: [
            {
              id: "child-1",
              media_type: "IMAGE",
              media_url: "https://example.com/child-1.jpg",
              permalink: "https://example.com/child-1",
              thumbnail_url: "https://example.com/child-1-thumb.jpg",
              timestamp: "2026-05-19T00:00:00+0000",
              username: "demo",
            },
          ],
        }) as never
      );
    });

    const result = await getMediaChildrenHandler()({
      media_id: TEST_MEDIA_ID,
      response_format: "json",
    });

    expect(result.isError).not.toBe(true);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.url).toBe(`${GRAPH_API_BASE}/${TEST_MEDIA_ID}/children`);

    const params = firstParams(state.requests);
    expect(params.fields).toBe(CHILD_FIELDS);
    expect(String(params.fields)).not.toContain("like_count");
    expect(String(params.fields)).not.toContain("comments_count");
    expect(String(params.fields)).not.toContain("caption");
    expect(params.access_token).toBe("userToken");
    expect(result.content[0]?.text).toContain('"id": "child-1"');
  });
});

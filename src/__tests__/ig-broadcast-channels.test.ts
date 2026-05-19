import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { MetaApiClient } from "../services/api.js";
import { registerInstagramTools } from "../tools/instagram.js";
import { mockAxios, TEST_IG_USER_ID } from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: { code?: string; message?: string };
};

type BroadcastChannelsArgs = {
  ig_account_id: string;
  response_format: "markdown" | "json";
};

type BroadcastChannelsHandler = (args: BroadcastChannelsArgs) => Promise<ToolResult>;

function getBroadcastChannelsHandler(): BroadcastChannelsHandler {
  const handlers = new Map<string, unknown>();
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown): void {
      handlers.set(name, handler);
    },
  };

  registerInstagramTools(server as unknown as McpServer, new MetaApiClient("userToken"));

  const handler = handlers.get("meta_get_instagram_broadcast_channels");
  if (typeof handler !== "function") {
    throw new Error("meta_get_instagram_broadcast_channels was not registered");
  }
  return handler as BroadcastChannelsHandler;
}

describe("meta_get_instagram_broadcast_channels deprecation", () => {
  it("returns a structured deprecation error without calling Meta", async () => {
    const state = mockAxios();

    const result = await getBroadcastChannelsHandler()({
      ig_account_id: TEST_IG_USER_ID,
      response_format: "json",
    });

    expect(state.requests).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("IG_BROADCAST_CHANNELS_DEPRECATED");
    expect(result.structuredContent?.message).toContain("no Broadcast Channels replacement");
    expect(result.structuredContent?.message).toContain(
      "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/"
    );
    expect(result.content[0]?.text).toContain("IG_BROADCAST_CHANNELS_DEPRECATED");
    expect(result.content[0]?.text).not.toContain("Unknown path components");
  });
});

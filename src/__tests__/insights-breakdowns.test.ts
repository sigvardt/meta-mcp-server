import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { MetaApiClient } from "../services/api.js";
import { registerInsightsTools } from "../tools/insights.js";

type InputSchema = {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } };
};

function getAccountInsightsSchema(): InputSchema {
  const configs = new Map<string, unknown>();
  const server = {
    registerTool(name: string, config: unknown): void {
      configs.set(name, config);
    },
  };

  registerInsightsTools(server as unknown as McpServer, new MetaApiClient("user-token"));

  const config = configs.get("meta_get_account_insights") as { inputSchema?: InputSchema } | undefined;
  if (!config?.inputSchema) {
    throw new Error("meta_get_account_insights was not registered");
  }
  return config.inputSchema;
}

describe("ads insights breakdown schema", () => {
  it("rejects removed placement breakdown", () => {
    const schema = getAccountInsightsSchema();

    const result = schema.safeParse({
      ad_account_id: "act_123",
      breakdowns: ["placement"],
      response_format: "json",
    });

    expect(result.success).toBe(false);
  });

  it("accepts platform_position breakdown", () => {
    const schema = getAccountInsightsSchema();

    const result = schema.safeParse({
      ad_account_id: "act_123",
      breakdowns: ["platform_position"],
      response_format: "json",
    });

    expect(result.success).toBe(true);
  });
});

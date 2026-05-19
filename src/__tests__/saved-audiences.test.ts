import type { AxiosRequestConfig } from "axios";
import { describe, expect, it, vi } from "vitest";
import { GRAPH_API_BASE } from "../constants.js";
import { BusinessAuthorizationService } from "../services/business-authorization.js";
import { MetaApiClient } from "../services/api.js";
import { registerAdsTools } from "../tools/ads.js";
import {
  ERR_SAVED_AUDIENCES_FIELD_REMOVED,
  TEST_AD_ACCOUNT_ID,
  mockAxios,
  mockSuccess,
} from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type SavedAudiencesArgs = {
  ad_account_id: string;
  limit?: number;
  after?: string;
  response_format?: "markdown" | "json";
};

type SavedAudiencesConfig = {
  inputSchema: {
    parse(value: unknown): SavedAudiencesArgs;
  };
};

type SavedAudiencesHandler = (args: SavedAudiencesArgs) => Promise<ToolResult>;
type AxiosState = ReturnType<typeof mockAxios>;

function getSavedAudiencesTool(): { config: SavedAudiencesConfig; handler: SavedAudiencesHandler } {
  const configs = new Map<string, unknown>();
  const handlers = new Map<string, unknown>();
  const server = {
    registerTool(name: string, config: unknown, handler: unknown): void {
      configs.set(name, config);
      handlers.set(name, handler);
    },
  };
  const client = new MetaApiClient("test-token");
  const authService = new BusinessAuthorizationService();
  authService.addAllowed("ad_account", TEST_AD_ACCOUNT_ID);
  client.attachAuthService(authService);

  registerAdsTools(server as never, client);

  const config = configs.get("meta_list_saved_audiences") as SavedAudiencesConfig | undefined;
  const handler = handlers.get("meta_list_saved_audiences");
  if (!config || typeof handler !== "function") {
    throw new Error("meta_list_saved_audiences was not registered");
  }

  return { config, handler: handler as SavedAudiencesHandler };
}

function mockNextSavedAudiencesSuccess({ axiosInstance, requests }: AxiosState): void {
  vi.mocked(axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
    requests.push({ method: "get", url, params: config?.params });

    const fields = String((config?.params as Record<string, unknown> | undefined)?.fields ?? "");
    if (fields.includes("approximate_count")) {
      return Promise.reject(ERR_SAVED_AUDIENCES_FIELD_REMOVED);
    }

    return Promise.resolve(
      mockSuccess({
        data: [
          {
            id: "audience-1",
            name: "Prospects",
            targeting: { age_min: 25 },
          },
        ],
      }) as never
    );
  });
}

describe("meta_list_saved_audiences defaults", () => {
  it("does not request approximate_count in the default fields list", async () => {
    const state = mockAxios();
    mockNextSavedAudiencesSuccess(state);
    const { config, handler } = getSavedAudiencesTool();

    const result = await handler(config.inputSchema.parse({ ad_account_id: TEST_AD_ACCOUNT_ID }));

    expect(result.isError).not.toBe(true);
    expect(state.requests).toHaveLength(1);

    const { url: requestUrl, params: requestParams } = state.requests[0]!;
    expect(requestUrl).toBe(`${GRAPH_API_BASE}/${TEST_AD_ACCOUNT_ID}/saved_audiences`);
    expect(requestParams).toMatchObject({
      access_token: "test-token",
      limit: 25,
    });

    const fields = String((requestParams as Record<string, unknown>).fields);
    expect(fields).toBe("id,name,targeting");
    expect(fields).not.toContain("approximate_count");
  });
});

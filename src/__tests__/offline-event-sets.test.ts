import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GRAPH_API_BASE } from "../constants.js";
import { BusinessAuthorizationService } from "../services/business-authorization.js";
import { MetaApiClient } from "../services/api.js";
import { registerAdsTools } from "../tools/ads.js";
import {
  ERR_OFFLINE_EVENT_SETS_FIELD_REMOVED,
  TEST_AD_ACCOUNT_ID,
  mockSuccess,
} from "./_fixtures.js";

vi.mock("axios");

type ToolHandler = (args: {
  ad_account_id: string;
  limit?: number;
  after?: string;
  response_format?: "markdown" | "json";
}) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function registerOfflineEventSetsHandler(): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    }),
  };
  const client = new MetaApiClient("test-token");
  const authService = new BusinessAuthorizationService();
  authService.addAllowed("ad_account", TEST_AD_ACCOUNT_ID);
  client.attachAuthService(authService);

  registerAdsTools(server as never, client);

  const handler = handlers.get("meta_list_offline_event_sets");
  if (!handler) {
    throw new Error("meta_list_offline_event_sets was not registered");
  }
  return handler;
}

describe("meta_list_offline_event_sets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not hit the removed offline_conversion_data_sets edge", async () => {
    const handler = registerOfflineEventSetsHandler();
    const mockedGet = vi.mocked(axios.get);

    mockedGet.mockImplementation((url: string) => {
      if (url.includes("/offline_conversion_data_sets")) {
        return Promise.reject(ERR_OFFLINE_EVENT_SETS_FIELD_REMOVED);
      }

      return Promise.resolve(
        mockSuccess({
          data: [
            {
              id: "custom-conversion-1",
              name: "In-store purchase",
              custom_event_type: "PURCHASE",
              event_source_id: "dataset-1",
              action_source_type: "physical_store",
            },
          ],
        })
      );
    });

    const result = await handler({
      ad_account_id: TEST_AD_ACCOUNT_ID,
      limit: 25,
      response_format: "json",
    });

    expect(result.isError).toBeUndefined();
    expect(mockedGet).toHaveBeenCalledTimes(1);
    const [requestUrl, requestConfig] = mockedGet.mock.calls[0];
    expect(requestUrl).toBe(`${GRAPH_API_BASE}/${TEST_AD_ACCOUNT_ID}/customconversions`);
    expect(requestUrl).not.toContain("/offline_conversion_data_sets");
    expect(requestConfig).toMatchObject({
      params: {
        access_token: "test-token",
        fields: "id,name,pixel,custom_event_type,rule,creation_time,event_source_id,action_source_type",
        limit: 25,
      },
    });
    expect(result.content[0].text).toContain("custom-conversion-1");
  });
});

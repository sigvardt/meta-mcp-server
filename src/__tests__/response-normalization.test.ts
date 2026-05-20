import type { AxiosRequestConfig } from "axios";
import { describe, expect, it, vi } from "vitest";
import { MetaApiClient } from "../services/api.js";
import { registerAdsTools } from "../tools/ads.js";
import { registerInstagramTools } from "../tools/instagram.js";
import { registerPageTools } from "../tools/pages.js";
import { registerUtilityTools } from "../tools/utility.js";
import { mockAxios, mockSuccess } from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type ToolHandler<TArgs extends Record<string, unknown>> = (args: TArgs) => Promise<ToolResult>;
type RegisterTools = (server: never, client: MetaApiClient) => void;

function toolHarness(registerTools: RegisterTools, client = new MetaApiClient("user-token")) {
  const handlers = new Map<string, unknown>();
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown): void {
      handlers.set(name, handler);
    },
  };

  registerTools(server as never, client);

  return {
    client,
    handler<TArgs extends Record<string, unknown>>(name: string): ToolHandler<TArgs> {
      const handler = handlers.get(name);
      if (typeof handler !== "function") {
        throw new Error(`${name} was not registered`);
      }
      return handler as ToolHandler<TArgs>;
    },
  };
}

function parseToolJson(result: ToolResult): unknown {
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]?.text ?? "null") as unknown;
}

function registerPageAndUtilityTools(server: never, client: MetaApiClient): void {
  registerPageTools(server, client);
  registerUtilityTools(server, client);
}

describe("Graph response sanitization", () => {
  it("strips access_token query params from Graph paging URLs", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(
        mockSuccess({
          data: [],
          paging: {
            next: "https://graph.facebook.com/v21.0/me/accounts?limit=25&access_token=secret-token&after=after-cursor",
            previous: "https://graph.facebook.com/v21.0/me/accounts?access_token=secret-token&before=before-cursor",
          },
        }) as never
      );
    });

    const client = new MetaApiClient("user-token");
    const response = await client.get<{ paging?: { next?: string; previous?: string } }>("/me/accounts", {
      fields: "id,name",
    });

    expect(response.paging?.next).toContain("after=after-cursor");
    expect(response.paging?.next).not.toContain("access_token");
    expect(response.paging?.previous).toContain("before=before-cursor");
    expect(response.paging?.previous).not.toContain("access_token");
    expect(state.requests[0]?.params).toMatchObject({ access_token: "user-token" });
  });
});

describe("read-tool JSON envelopes", () => {
  it("redacts page access tokens from meta_list_pages while keeping them cached", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(
        mockSuccess({
          data: [
            {
              id: "page-1",
              name: "Main Page",
              category: "Retail",
              access_token: "page-secret-token",
            },
          ],
          paging: {
            next: "https://graph.facebook.com/v21.0/me/accounts?access_token=user-secret&after=next-cursor",
          },
        }) as never
      );
    });
    const { client, handler } = toolHarness(registerPageTools as unknown as RegisterTools);

    const result = await handler<{ response_format: "json" }>("meta_list_pages")({ response_format: "json" });
    const payload = parseToolJson(result) as {
      data: Array<{ id: string; access_token?: string }>;
      paging?: { next?: string };
    };

    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]).toMatchObject({ id: "page-1" });
    expect(payload.data[0]).not.toHaveProperty("access_token");
    expect(payload.paging?.next).not.toContain("access_token");
    expect(client.getPageToken("page-1")).toBe("page-secret-token");
  });

  it("reports page tokens cached in meta_health_check after meta_list_pages", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get)
      .mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
        state.requests.push({ method: "get", url, params: config?.params });
        return Promise.resolve(
          mockSuccess({
            data: [
              {
                id: "page-1",
                name: "Main Page",
                category: "Retail",
                access_token: "page-secret-token",
              },
            ],
          }) as never
        );
      })
      .mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
        state.requests.push({ method: "get", url, params: config?.params });
        return Promise.resolve(mockSuccess({ id: "user-1" }) as never);
      });
    const { handler } = toolHarness(registerPageAndUtilityTools as unknown as RegisterTools);

    await handler<{ response_format: "json" }>("meta_list_pages")({ response_format: "json" });
    const result = await handler<{ response_format: "json" }>("meta_health_check")({ response_format: "json" });
    const payload = parseToolJson(result) as Record<string, string>;

    expect(payload["Cached page tokens"]).toBe("1 pages");
  });

  it("wraps empty meta_list_ad_accounts JSON output in a data envelope", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(mockSuccess({ data: [], paging: { cursors: { after: "next" } } }) as never);
    });
    const { handler } = toolHarness(registerAdsTools as unknown as RegisterTools);

    const result = await handler<{ response_format: "json" }>("meta_list_ad_accounts")({ response_format: "json" });
    const payload = parseToolJson(result) as { data: unknown[]; paging?: unknown };

    expect(payload).toMatchObject({ data: [], paging: { cursors: { after: "next" } } });
  });

  it("wraps meta_list_instagram_accounts JSON output in a data envelope", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(
        mockSuccess({
          data: [
            {
              id: "page-1",
              name: "Main Page",
              access_token: "page-secret-token",
              instagram_business_account: { id: "ig-1", username: "main", followers_count: 10 },
            },
          ],
        }) as never
      );
    });
    const { handler } = toolHarness(registerInstagramTools as unknown as RegisterTools);

    const result = await handler<{ response_format: "json" }>("meta_list_instagram_accounts")({
      response_format: "json",
    });
    const payload = parseToolJson(result) as { data: Array<{ id: string; page_id: string }> };

    expect(payload.data).toEqual([{ id: "ig-1", username: "main", followers_count: 10, page_name: "Main Page", page_id: "page-1" }]);
  });
});

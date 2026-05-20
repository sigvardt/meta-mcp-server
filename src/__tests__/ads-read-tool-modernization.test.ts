import type { AxiosRequestConfig } from "axios";
import { describe, expect, it, vi } from "vitest";
import { MetaApiClient } from "../services/api.js";
import { registerAdsTools } from "../tools/ads.js";
import { mockAxios, mockSuccess } from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type ToolHandler<TArgs extends Record<string, unknown>> = (args: TArgs) => Promise<ToolResult>;

function adsHandler<TArgs extends Record<string, unknown>>(name: string): ToolHandler<TArgs> {
  const handlers = new Map<string, unknown>();
  const server = {
    registerTool(toolName: string, _config: unknown, handler: unknown): void {
      handlers.set(toolName, handler);
    },
  };

  registerAdsTools(server as never, new MetaApiClient("user-token"));

  const handler = handlers.get(name);
  if (typeof handler !== "function") {
    throw new Error(`${name} was not registered`);
  }
  return handler as ToolHandler<TArgs>;
}

function parseToolJson(result: ToolResult): unknown {
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]?.text ?? "null") as unknown;
}

describe("ads read-tool request modernization", () => {
  it("requests only current delivery estimate fields", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(mockSuccess({ data: [] }) as never);
    });

    const result = await adsHandler<{ adset_id: string; response_format: "json" }>("meta_get_delivery_estimate")({
      adset_id: "adset-1",
      response_format: "json",
    });

    expect(result.isError).not.toBe(true);
    const params = state.requests[0]?.params as Record<string, unknown>;
    const fieldList = String(params.fields).split(",");
    expect(fieldList).toEqual([
      "daily_outcomes_curve",
      "estimate_dau",
      "estimate_mau_lower_bound",
      "estimate_mau_upper_bound",
      "estimate_ready",
      "targeting_optimization_types",
    ]);
    expect(fieldList).not.toContain("estimate_mau");
    expect(fieldList).not.toContain("bid_estimate");
  });

  it("omits ad video thumbnails when thumbnails_limit is zero", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(
        mockSuccess({
          data: [
            {
              id: "video-1",
              title: "Demo",
              thumbnails: {
                data: [
                  { uri: "fallback", is_preferred: false },
                  { uri: "preferred", is_preferred: true },
                  { uri: "extra", is_preferred: false },
                ],
              },
            },
          ],
        }) as never
      );
    });

    const result = await adsHandler<{
      ad_account_id: string;
      limit: number;
      thumbnails_limit: number;
      response_format: "json";
    }>("meta_list_ad_videos")({
      ad_account_id: "act_123",
      limit: 20,
      thumbnails_limit: 0,
      response_format: "json",
    });

    expect(result.isError).not.toBe(true);
    const params = state.requests[0]?.params as Record<string, unknown>;
    expect(params.fields).not.toContain("thumbnails");
  });

  it("requests only the configured number of ad video thumbnails by default", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(
        mockSuccess({
          data: [
            {
              id: "video-1",
              title: "Demo",
              thumbnails: {
                data: [
                  { uri: "fallback", is_preferred: false },
                  { uri: "preferred", is_preferred: true },
                  { uri: "unused", is_preferred: false },
                ],
              },
            },
          ],
        }) as never
      );
    });

    const result = await adsHandler<{
      ad_account_id: string;
      limit: number;
      after?: string;
      thumbnails_limit: number;
      response_format: "json";
    }>("meta_list_ad_videos")({
      ad_account_id: "act_123",
      limit: 20,
      thumbnails_limit: 1,
      response_format: "json",
    });

    expect(result.isError).not.toBe(true);
    const params = state.requests[0]?.params as Record<string, unknown>;
    expect(params.fields).toContain("thumbnails.limit(1)");
    const payload = parseToolJson(result) as {
      data: Array<{ thumbnails: { data: Array<{ uri: string; is_preferred: boolean }> } }>;
    };
    expect(payload.data[0]?.thumbnails.data).toEqual([{ uri: "preferred", is_preferred: true }]);
  });

  it("filters placement_asset system labels by default and keeps the paging envelope", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(
        mockSuccess({
          data: [
            { id: "label-1", name: "placement_asset_feed" },
            { id: "label-2", name: "Sale" },
          ],
          paging: { cursors: { after: "next" } },
        }) as never
      );
    });

    const result = await adsHandler<{
      ad_account_id: string;
      limit: number;
      include_system_labels: boolean;
      response_format: "json";
    }>("meta_list_ad_labels")({
      ad_account_id: "act_123",
      limit: 25,
      include_system_labels: false,
      response_format: "json",
    });
    const payload = parseToolJson(result) as { data: Array<{ name: string }>; paging?: unknown };

    expect(payload.data).toEqual([{ id: "label-2", name: "Sale" }]);
    expect(payload.paging).toMatchObject({ cursors: { after: "next" } });
    expect(state.requests[0]?.params).toMatchObject({ limit: 25 });
  });

  it("parses custom conversion rule JSON strings in JSON output", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(
        mockSuccess({
          data: [{ id: "cc-1", name: "Thank You", rule: '{"url":{"i_contains":"thank-you"}}' }],
        }) as never
      );
    });

    const result = await adsHandler<{ ad_account_id: string; response_format: "json" }>(
      "meta_list_custom_conversions"
    )({ ad_account_id: "act_123", response_format: "json" });
    const payload = parseToolJson(result) as { data: Array<{ rule: unknown }> };

    expect(payload.data[0]?.rule).toEqual({ url: { i_contains: "thank-you" } });
  });

  it("passes limit and after through to targeting category browse", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(mockSuccess({ data: [] }) as never);
    });

    const result = await adsHandler<{
      type: "adTargetingCategory";
      class?: "interests";
      limit: number;
      after: string;
      response_format: "json";
    }>("meta_browse_targeting_categories")({
      type: "adTargetingCategory",
      class: "interests",
      limit: 7,
      after: "cursor-1",
      response_format: "json",
    });

    expect(result.isError).not.toBe(true);
    expect(state.requests[0]?.params).toMatchObject({ limit: 7, after: "cursor-1" });
  });

  it("locally paginates targeting categories when Graph ignores limit", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(
        mockSuccess({
          data: [
            { id: "cat-1", name: "One" },
            { id: "cat-2", name: "Two" },
            { id: "cat-3", name: "Three" },
          ],
        }) as never
      );
    });

    const result = await adsHandler<{
      type: "adTargetingCategory";
      limit: number;
      response_format: "json";
    }>("meta_browse_targeting_categories")({
      type: "adTargetingCategory",
      limit: 2,
      response_format: "json",
    });
    const payload = parseToolJson(result) as {
      data: Array<{ id: string }>;
      paging?: { cursors?: { after?: string } };
    };

    expect(payload.data).toEqual([{ id: "cat-1", name: "One" }, { id: "cat-2", name: "Two" }]);
    expect(payload.paging?.cursors?.after).toBe("local-targeting-offset:2");
  });

  it("uses local targeting cursors without sending them to Graph", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(
        mockSuccess({
          data: [
            { id: "cat-1", name: "One" },
            { id: "cat-2", name: "Two" },
            { id: "cat-3", name: "Three" },
          ],
        }) as never
      );
    });

    const result = await adsHandler<{
      type: "adTargetingCategory";
      limit: number;
      after: string;
      response_format: "json";
    }>("meta_browse_targeting_categories")({
      type: "adTargetingCategory",
      limit: 2,
      after: "local-targeting-offset:2",
      response_format: "json",
    });
    const payload = parseToolJson(result) as { data: Array<{ id: string }> };

    expect(state.requests[0]?.params).not.toMatchObject({ after: "local-targeting-offset:2" });
    expect(payload.data).toEqual([{ id: "cat-3", name: "Three" }]);
  });

  it("registers meta_list_ad_studies as an alias while preserving meta_get_ad_studies", async () => {
    const state = mockAxios();
    vi.mocked(state.axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
      state.requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve(mockSuccess({ data: [] }) as never);
    });

    const result = await adsHandler<{ ad_account_id: string; limit: number; response_format: "json" }>(
      "meta_list_ad_studies"
    )({ ad_account_id: "act_123", limit: 10, response_format: "json" });
    const payload = parseToolJson(result) as { data: unknown[] };

    expect(payload.data).toEqual([]);
    expect(state.requests[0]?.url).toContain("/act_123/ad_studies");

    expect(() => adsHandler("meta_get_ad_studies")).not.toThrow();
  });
});

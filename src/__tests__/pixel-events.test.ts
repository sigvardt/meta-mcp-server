import { describe, expect, it, vi } from "vitest";
import { MetaApiClient } from "../services/api.js";
import { registerAdsTools } from "../tools/ads.js";

describe("meta_get_pixel_events registration", () => {
  it("does not register the removed /test_events tool", () => {
    const registerTool = vi.fn();
    const server = { registerTool };
    const client = new MetaApiClient("test-token");

    registerAdsTools(server as never, client);

    const registeredToolNames = registerTool.mock.calls.map(([name]) => name);
    expect(registeredToolNames).toContain("meta_get_pixel_stats");
    expect(registeredToolNames).not.toContain("meta_get_pixel_events");
  });
});

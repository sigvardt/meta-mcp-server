import type { AxiosRequestConfig } from "axios";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { GRAPH_API_BASE } from "../constants.js";
import { MetaApiClient } from "../services/api.js";
import { registerPageTools } from "../tools/pages.js";
import { mockAxios, mockSuccess } from "./_fixtures.js";

vi.mock("axios");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type AutomatedResponsesArgs = {
  page_id: string;
  response_format: "markdown" | "json";
};

type AutomatedResponsesConfig = {
  inputSchema: {
    parse(value: unknown): AutomatedResponsesArgs;
  };
};

type AutomatedResponsesHandler = (args: AutomatedResponsesArgs) => Promise<ToolResult>;
type AxiosState = ReturnType<typeof mockAxios>;

const TEST_AUTOMATED_PAGE_ID = "TEST_PAGE_ID";
const PAGE_TOKEN_FIXTURE = "PAGE_TOKEN_FIXTURE";
const USER_TOKEN_FIXTURE = "USER_TOKEN_FIXTURE";
const MESSENGER_PROFILE_FIELDS =
  "greeting,ice_breakers,get_started,persistent_menu,whitelisted_domains,account_linking_url,commands";

function getAutomatedResponsesTool(): {
  config: AutomatedResponsesConfig;
  handler: AutomatedResponsesHandler;
} {
  const configs = new Map<string, unknown>();
  const handlers = new Map<string, unknown>();
  const server = {
    registerTool(name: string, config: unknown, handler: unknown): void {
      configs.set(name, config);
      handlers.set(name, handler);
    },
  };
  const client = new MetaApiClient(USER_TOKEN_FIXTURE);
  client.cachePageToken(TEST_AUTOMATED_PAGE_ID, PAGE_TOKEN_FIXTURE);

  registerPageTools(server as unknown as McpServer, client);

  const config = configs.get("meta_get_page_automated_responses") as AutomatedResponsesConfig | undefined;
  const handler = handlers.get("meta_get_page_automated_responses");
  if (!config || typeof handler !== "function") {
    throw new Error("meta_get_page_automated_responses was not registered");
  }

  return { config, handler: handler as AutomatedResponsesHandler };
}

function mockMessengerProfileResponse({ axiosInstance, requests }: AxiosState): void {
  vi.mocked(axiosInstance.get).mockImplementationOnce((url: string, config?: AxiosRequestConfig) => {
    requests.push({ method: "get", url, params: config?.params });
    return Promise.resolve(
      mockSuccess({
        data: [
          {
            greeting: [{ locale: "default", text: "Hello from Messenger" }],
            ice_breakers: [
              {
                locale: "default",
                call_to_actions: [{ question: "What are your hours?", payload: "HOURS" }],
              },
            ],
            get_started: { payload: "GET_STARTED" },
            persistent_menu: [
              {
                locale: "default",
                composer_input_disabled: false,
                call_to_actions: [{ type: "postback", title: "Talk to us", payload: "CARE_HELP" }],
              },
            ],
            whitelisted_domains: ["https://example.com"],
            account_linking_url: "https://example.com/account-linking",
            commands: [
              {
                locale: "default",
                commands: [{ name: "hours", description: "Show opening hours" }],
              },
            ],
          },
        ],
      }) as never
    );
  });
}

function firstRequest(requests: AxiosState["requests"]): AxiosState["requests"][number] {
  expect(requests).toHaveLength(1);
  expect(requests[0]).toBeDefined();
  return requests[0] as AxiosState["requests"][number];
}

describe("meta_get_page_automated_responses", () => {
  it("requires a page_id", () => {
    const { config } = getAutomatedResponsesTool();

    expect(() => config.inputSchema.parse({ response_format: "markdown" })).toThrow();
  });

  it("retrieves Messenger Profile fields with the cached Page token and returns a summary", async () => {
    const state = mockAxios();
    mockMessengerProfileResponse(state);
    const { config, handler } = getAutomatedResponsesTool();

    const result = await handler(
      config.inputSchema.parse({
        page_id: TEST_AUTOMATED_PAGE_ID,
        response_format: "json",
      })
    );

    expect(result.isError).not.toBe(true);
    const request = firstRequest(state.requests);
    const params = request.params as Record<string, unknown>;
    expect(request.url).toBe(`${GRAPH_API_BASE}/me/messenger_profile`);
    expect(params.fields).toBe(MESSENGER_PROFILE_FIELDS);
    expect(params.access_token).toBe(PAGE_TOKEN_FIXTURE);
    expect(params.access_token).not.toBe(USER_TOKEN_FIXTURE);
    expect(result.content[0]?.text).toContain("Greeting:");
    expect(result.content[0]?.text).toContain("Ice Breakers:");
    expect(result.content[0]?.text).toContain("Persistent Menu:");
    expect(result.content[0]?.text).toContain("Get Started:");
    expect(result.content[0]?.text).not.toContain('"data"');
  });
});

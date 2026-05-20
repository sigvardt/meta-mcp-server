#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MetaApiClient } from "./services/api.js";
import { BusinessAuthorizationService } from "./services/business-authorization.js";
import { registerPageTools } from "./tools/pages.js";
import { registerInstagramTools } from "./tools/instagram.js";
import { registerAdsTools } from "./tools/ads.js";
import { registerAudiencesTools } from "./tools/audiences.js";
import { registerInsightsTools } from "./tools/insights.js";
import { registerThreadsTools } from "./tools/threads.js";
import { registerAdLibraryTools } from "./tools/ad_library.js";
import { registerConversionTools } from "./tools/conversions.js";
import { registerUtilityTools } from "./tools/utility.js";
import { registerChartTools } from "./tools/charts.js";
import { registerCommerceTools } from "./tools/commerce.js";
import { resolveApiKey } from "./op-fallback.js";

resolveApiKey("META_ACCESS_TOKEN", "op://Development/Meta Access Token/credential");
resolveApiKey("THREADS_ACCESS_TOKEN", "op://Development/Threads Access Token/credential");

const token = process.env.META_ACCESS_TOKEN ?? "";
const threadsToken = process.env.THREADS_ACCESS_TOKEN;

const client = new MetaApiClient(token, threadsToken);
const authService = new BusinessAuthorizationService();
client.attachAuthService(authService);
if (token) {
  await authService.bootstrap(client);

  const authAllowlistSummary = Object.entries(authService.getSnapshot())
    .map(([type, ids]) => `${ids.length} ${type}`)
    .join(", ");
  console.error(
    authAllowlistSummary === "1 all"
      ? "[meta-mcp] business-auth allowlist: unrestricted (META_ALLOWED_BUSINESS_IDS not set)"
      : `[meta-mcp] business-auth allowlist: ${authAllowlistSummary}`
  );
} else {
  console.error(
    "[meta-mcp] META_ACCESS_TOKEN not set; skipping business-auth bootstrap."
  );
}

const server = new McpServer({
  name: "meta-mcp-server",
  version: "2.1.3",
});

registerPageTools(server, client);
registerInstagramTools(server, client);
registerAdsTools(server, client);
registerAudiencesTools(server, client);
registerInsightsTools(server, client);
registerThreadsTools(server, client);
registerAdLibraryTools(server, client);
registerConversionTools(server, client);
registerUtilityTools(server, client);
registerChartTools(server);
registerCommerceTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);

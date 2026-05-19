#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ACID_TEST_POST_TEXT,
  DEFAULT_BUSINESS_ID,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
} from "./_constants.mjs";
import {
  appendOrphan,
  journalIsEmpty,
  readOrphans,
  scrubOrphan,
} from "./_orphan-journal.mjs";
import { callTool as rawCallTool, listTools, startMcpServer, stopMcpServer } from "./_mcp-client.mjs";

export const DYNAMIC_RETAIL_BUSINESS_ID = DEFAULT_BUSINESS_ID;
export const LIVE_ACID_TEXT = ACID_TEST_POST_TEXT;
export { ORPHAN_LOG_PATH } from "./_constants.mjs";
export { journalIsEmpty, scrubOrphan };

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

function parseArgs(argv) {
  const options = {
    tool: null,
    mode: "read-only",
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--write") {
      options.mode = "write";
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      const mode = arg.slice("--mode=".length);

      if (!["read-only", "write"].includes(mode)) {
        throw new Error(`Invalid mode: ${mode}`);
      }

      options.mode = mode;
      continue;
    }

    if (arg.startsWith("--tool=")) {
      options.tool = arg.slice("--tool=".length);
      continue;
    }

    throw new Error(`Unknown flag: ${arg}`);
  }

  return options;
}

function printUsage() {
  console.error("Usage: RUN_LIVE_ACID=1 node scripts/live-acid-test.mjs [--mode=read-only|write] [--tool=<name>]");
  console.error("Runs live tests against Dynamic Retail ApS Meta resources only.");
}

function loadDotEnv(env) {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (env[key] === undefined) env[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function addTotals(left, right) {
  return {
    pass: left.pass + right.pass,
    fail: left.fail + right.fail,
    tests: left.tests + right.tests,
  };
}

function toolNamesFromResult(toolsResult) {
  return new Set((toolsResult.tools ?? []).map((tool) => tool.name));
}

function selectedTools(ctx, defaultTools) {
  return ctx.selectedTool ? [ctx.selectedTool] : defaultTools;
}

function validateToolCoverage(label, toolNames, registeredToolNames) {
  const missing = toolNames.filter((toolName) => !registeredToolNames.has(toolName));

  if (missing.length > 0) {
    for (const toolName of missing) {
      console.error(`[live-acid] ${label} tool missing from MCP registry: ${toolName}`);
    }

    return { pass: 0, fail: missing.length, tests: missing.length };
  }

  console.error(`[live-acid] ${label} tool coverage verified: ${toolNames.join(", ")}`);
  return null;
}

function resultText(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function parseJsonResult(result, label) {
  const text = resultText(result);

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${text.slice(0, 500)}`);
  }
}

function assertOk(result, forbidden = []) {
  const text = resultText(result);

  if (result.isError) {
    throw new Error(text || "MCP tool returned isError");
  }

  for (const needle of forbidden) {
    if (text.toLowerCase().includes(needle.toLowerCase())) {
      throw new Error(`Response contained forbidden regression marker ${JSON.stringify(needle)}: ${text.slice(0, 800)}`);
    }
  }

  return text;
}

function assertTextIncludes(text, needle) {
  if (!text.includes(needle)) {
    throw new Error(`Expected response to include ${JSON.stringify(needle)}; got: ${text.slice(0, 800)}`);
  }
}

function assertAdInsightsResponse(result, text, noDataMessage, label) {
  const responseText = assertOk(result, ["unique_impressions"]);
  if (responseText.includes(noDataMessage)) {
    return `no ${label} insights for selected period; unique_impressions regression absent`;
  }
  assertTextIncludes(text, "**Impressions**");
  return "Impressions line present; unique_impressions regression absent";
}

function firstArrayItem(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`No ${label} found during live-acid setup`);
  }

  return value[0];
}

function idOf(value, label) {
  if (!value?.id) {
    throw new Error(`${label} did not include an id`);
  }

  return String(value.id);
}

function normalizeAdAccountId(id) {
  const value = String(id);
  return value.startsWith("act_") ? value : `act_${value}`;
}

function normalizeMetaId(id) {
  return String(id).replace(/^act_/, "");
}

const INSTAGRAM_CONTEXT_TOOLS = new Set([
  "meta_get_instagram_account_insights",
  "meta_get_instagram_broadcast_channels",
  "meta_search_instagram_hashtag",
  "meta_get_instagram_media_children",
]);

function needsInstagramContext(ctx) {
  return !ctx.selectedTool || INSTAGRAM_CONTEXT_TOOLS.has(ctx.selectedTool);
}

async function callTool(toolName, args = {}) {
  return rawCallTool(toolName, args);
}

async function callJson(toolName, args = {}) {
  const result = await callTool(toolName, { ...args, response_format: "json" });
  assertOk(result);
  return parseJsonResult(result, toolName);
}

async function callJsonOrEmptyData(toolName, args = {}) {
  const result = await callTool(toolName, { ...args, response_format: "json" });
  const text = assertOk(result);

  try {
    return JSON.parse(text);
  } catch (error) {
    if (/^No .* found/.test(text) || /^No .* available/.test(text)) {
      return { data: [] };
    }

    throw new Error(`${toolName} did not return JSON: ${text.slice(0, 500)}`);
  }
}

async function callMarkdown(toolName, args = {}) {
  const result = await callTool(toolName, { ...args, response_format: "markdown" });
  return { result, text: resultText(result) };
}

async function firstAllowedPage(pages) {
  for (const page of pages) {
    const pageId = page?.id ? String(page.id) : "";
    if (!pageId) continue;

    const result = await callTool("meta_get_page", { page_id: pageId, response_format: "json" });
    const text = resultText(result);
    if (!result.isError) return page;
    if (!text.includes("BUSINESS_AUTH_DENIED")) {
      throw new Error(`Page probe failed for ${pageId}: ${text}`);
    }
  }

  throw new Error(`No page returned for Dynamic Retail business ${DEFAULT_BUSINESS_ID}`);
}

async function firstAllowedAdAccount(adAccounts) {
  for (const account of adAccounts) {
    const accountId = account?.id ? normalizeAdAccountId(account.id) : "";
    if (!accountId) continue;

    const result = await callTool("meta_list_campaigns", { ad_account_id: accountId, limit: 1, response_format: "json" });
    const text = resultText(result);
    if (!result.isError) return account;
    if (!text.includes("BUSINESS_AUTH_DENIED")) {
      throw new Error(`Ad account probe failed for ${accountId}: ${text}`);
    }
  }

  throw new Error(`No ad account returned for Dynamic Retail business ${DEFAULT_BUSINESS_ID}`);
}

async function pageScopedInstagramAccount(page, pageId) {
  const pageInstagramAccount = page?.instagram_business_account;
  if (pageInstagramAccount?.id) {
    return { ...pageInstagramAccount, page_id: pageId };
  }

  const pageDetails = await callJson("meta_get_page", { page_id: pageId });
  const detailedInstagramAccount = pageDetails?.instagram_business_account;
  if (detailedInstagramAccount?.id) {
    return { ...detailedInstagramAccount, page_id: pageId };
  }

  return undefined;
}

function isBusinessAuthDenied(error) {
  return String(error?.message ?? error).includes("BUSINESS_AUTH_DENIED");
}

/**
 * @param {{
 *   pageScopedAccount?: Record<string, unknown>,
 *   igAccounts?: Array<Record<string, unknown>>,
 *   pageId: string,
 *   businessInstagramAccountIds: Set<string>,
 * }} params
 */
export function selectAcidInstagramAccount({ pageScopedAccount, igAccounts = [], pageId, businessInstagramAccountIds }) {
  const isBusinessInstagramAccount = (account) =>
    account?.id && businessInstagramAccountIds.has(normalizeMetaId(account.id));

  return (
    (isBusinessInstagramAccount(pageScopedAccount) ? pageScopedAccount : undefined) ??
    igAccounts.find(isBusinessInstagramAccount) ??
    igAccounts.find((account) => normalizeMetaId(account?.page_id) === normalizeMetaId(pageId)) ??
    pageScopedAccount ??
    firstArrayItem(igAccounts, "Instagram accounts")
  );
}

async function resolveUsableInstagramContext(igAccount) {
  const igAccountId = idOf(igAccount, "Instagram account");
  const igMediaData = await callJsonOrEmptyData("meta_get_instagram_media", { ig_account_id: igAccountId, limit: 100 });
  const igMedia = Array.isArray(igMediaData.data) ? igMediaData.data : [];
  const carouselMedia = igMedia.find((media) => media.media_type === "CAROUSEL_ALBUM" || media.media_product_type === "CAROUSEL_ALBUM");
  const carouselMediaId = carouselMedia?.id ? String(carouselMedia.id) : undefined;

  return { carouselMediaId, igAccountId };
}

async function tokenWideInstagramAccount(pageId, businessInstagramAccountIds = new Set()) {
  const igAccounts = await callJson("meta_list_instagram_accounts");
  return selectAcidInstagramAccount({ igAccounts, pageId, businessInstagramAccountIds });
}

async function resolveInstagramContext({ page, pages, pageId }) {
  const candidates = [page, ...pages.filter((candidate) => normalizeMetaId(candidate?.id) !== normalizeMetaId(pageId))];
  const deniedIds = [];

  for (const candidate of candidates) {
    const candidatePageId = candidate?.id ? String(candidate.id) : "";
    if (!candidatePageId) continue;
    const pageScopedAccount = await pageScopedInstagramAccount(candidate, candidatePageId);
    if (!pageScopedAccount?.id) continue;

    try {
      return await resolveUsableInstagramContext(pageScopedAccount);
    } catch (error) {
      if (!isBusinessAuthDenied(error)) throw error;
      deniedIds.push(String(pageScopedAccount.id));
    }
  }

  try {
    const businessInstagramAccounts = await callJsonOrEmptyData("meta_list_business_assets", {
      business_id: DEFAULT_BUSINESS_ID,
      asset_type: "owned_instagram_accounts",
      limit: 100,
    });
    const businessInstagramAccountIds = new Set((businessInstagramAccounts.data ?? []).map((account) => normalizeMetaId(account.id)));
    const igAccount = await tokenWideInstagramAccount(pageId, businessInstagramAccountIds);
    return await resolveUsableInstagramContext(igAccount);
  } catch (error) {
    if (isBusinessAuthDenied(error)) {
      throw new Error(
        `No Dynamic Retail Instagram account linked to an allowlisted page; refused token-wide Instagram account(s): ${deniedIds.join(", ") || "unknown"}`
      );
    }
    throw error;
  }
}

async function setupAcidContext(ctx) {
  if (ctx.acidContext) {
    return ctx.acidContext;
  }

  const businessPages = await callJsonOrEmptyData("meta_list_business_assets", {
    business_id: DEFAULT_BUSINESS_ID,
    asset_type: "owned_pages",
    limit: 100,
  });
  const businessPageIds = new Set((businessPages.data ?? []).map((page) => normalizeMetaId(page.id)));

  const businessAdAccounts = await callJsonOrEmptyData("meta_list_business_assets", {
    business_id: DEFAULT_BUSINESS_ID,
    asset_type: "owned_ad_accounts",
    limit: 100,
  });
  const businessAdAccountIds = new Set((businessAdAccounts.data ?? []).map((account) => normalizeMetaId(account.id)));

  const businessPixels = await callJsonOrEmptyData("meta_list_business_assets", {
    business_id: DEFAULT_BUSINESS_ID,
    asset_type: "owned_pixels",
    limit: 100,
  });
  const businessPixelIds = new Set((businessPixels.data ?? []).map((pixel) => normalizeMetaId(pixel.id)));

  const pages = await callJson("meta_list_pages");
  const page =
    pages.find((candidate) => businessPageIds.has(normalizeMetaId(candidate?.id))) ??
    await firstAllowedPage(pages);
  const pageId = idOf(page, "page");

  let adAccountId;
  let campaignId;
  let adsetId;
  let adId;
  let adError;

  try {
    if (ctx.mode === "write") throw new Error("Ad discovery skipped for write-only mode");
    const adAccounts = await callJson("meta_list_ad_accounts");
    const adAccount =
      adAccounts.find((account) => businessAdAccountIds.has(normalizeMetaId(account?.id))) ??
      await firstAllowedAdAccount(adAccounts);
    adAccountId = normalizeAdAccountId(idOf(adAccount, "ad account"));
    if (businessAdAccountIds.size > 0 && !businessAdAccountIds.has(normalizeMetaId(adAccountId))) {
      throw new Error(`No ad account returned for Dynamic Retail business ${DEFAULT_BUSINESS_ID}`);
    }

    const campaignsData = await callJsonOrEmptyData("meta_list_campaigns", { ad_account_id: adAccountId, limit: 20 });
    const campaigns = Array.isArray(campaignsData.data) ? campaignsData.data : [];
    campaignId = campaigns[0]?.id ? String(campaigns[0].id) : undefined;

    const adsetsData = await callJsonOrEmptyData("meta_list_adsets", { ad_account_id: adAccountId, limit: 20 });
    const adsets = Array.isArray(adsetsData.data) ? adsetsData.data : [];
    adsetId = adsets[0]?.id ? String(adsets[0].id) : undefined;

    const adsData = await callJsonOrEmptyData("meta_list_ads", { ad_account_id: adAccountId, limit: 20 });
    const ads = Array.isArray(adsData.data) ? adsData.data : [];
    adId = ads[0]?.id ? String(ads[0].id) : undefined;
  } catch (error) {
    adError = error;
  }

  const postsData = await callJsonOrEmptyData("meta_get_posts", { page_id: pageId, limit: 20 });
  const posts = Array.isArray(postsData.data) ? postsData.data : [];
  const postId = posts[0]?.id ? String(posts[0].id) : undefined;

  let carouselMediaId;
  let igAccountId;
  let igError;
  if (needsInstagramContext(ctx)) {
    try {
      ({ carouselMediaId, igAccountId } = await resolveInstagramContext({
        page,
        pages,
        pageId,
      }));
    } catch (error) {
      igError = error;
      if (!ctx.selectedTool || INSTAGRAM_CONTEXT_TOOLS.has(ctx.selectedTool)) throw error;
    }
  }

  let pixelId;
  let pixelError;
  try {
    if (ctx.mode === "write") throw new Error("Pixel discovery skipped for write-only mode");
    if (!adAccountId) throw adError ?? new Error("No ad account available for pixel discovery");
    const pixelsData = await callJsonOrEmptyData("meta_list_pixels", { ad_account_id: adAccountId });
    const pixels = Array.isArray(pixelsData.data) ? pixelsData.data : [];
    const pixel = pixels.find((candidate) => businessPixelIds.has(normalizeMetaId(candidate?.id))) ?? pixels[0];
    pixelId = pixel?.id ? String(pixel.id) : undefined;
    if (pixelId && businessPixelIds.size > 0 && !businessPixelIds.has(normalizeMetaId(pixelId))) {
      throw new Error(`No pixel returned for Dynamic Retail business ${DEFAULT_BUSINESS_ID}`);
    }
  } catch (error) {
    pixelError = error;
  }

  ctx.acidContext = {
    adAccountId,
    adId,
    adsetId,
    adError,
    campaignId,
    carouselMediaId,
    igAccountId,
    igError,
    pageId,
    pixelId,
    pixelError,
    postId,
  };

  console.error(
    `[live-acid] setup resolved page=${pageId} ad_account=${adAccountId} campaign=${campaignId ?? "none"} adset=${adsetId ?? "none"} ad=${adId ?? "none"} ig=${igAccountId ?? "skipped"} pixel=${pixelId ?? "none"}`
  );

  return ctx.acidContext;
}

async function acidTest(name, fn) {
  try {
    const evidence = await fn();
    const result = { name, status: "pass", evidence: String(evidence ?? "passed") };
    console.error(`[live-acid] PASS ${name}: ${result.evidence}`);
    return result;
  } catch (error) {
    const result = { name, status: "fail", evidence: error?.stack ?? String(error) };
    console.error(`[live-acid] FAIL ${name}: ${error?.message ?? String(error)}`);
    return result;
  }
}

async function runAcid(toolName, callArgs, assertion) {
  const { result, text } = await callMarkdown(toolName, callArgs);
  const evidence = assertion(result, text);
  return evidence ?? text.split("\n").find(Boolean) ?? "structured response returned";
}

async function runAcidSuite(label, tests) {
  const results = [];

  for (const test of tests) {
    results.push(await acidTest(test.name, test.run));
  }

  const pass = results.filter((result) => result.status === "pass").length;
  const fail = results.length - pass;
  console.error(`[live-acid] ${label} suite: ${pass} pass / ${fail} fail`);
  return { pass, fail, tests: results.length, results };
}

function buildReadTests(ctx) {
  return [
    {
      name: "meta_get_account_insights",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        if (!acid.adAccountId) throw acid.adError ?? new Error("No ad account available");
        return runAcid("meta_get_account_insights", { ad_account_id: acid.adAccountId, date_preset: "last_30d" }, (_result, _text) => {
          // T3 removed unique_impressions from INSIGHT_FIELDS; sparse/no-data accounts pass as long as Meta no longer reports the deprecated-field error.
          assertOk(_result, ["(#100)", "unique_impressions", "is not valid for fields param"]);
          return "unique_impressions deprecated-field regression absent";
        });
      },
    },
    {
      name: "meta_get_campaign_insights",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        if (!acid.adAccountId) throw acid.adError ?? new Error("No ad account available");
        return runAcid("meta_get_campaign_insights", { ad_account_id: acid.adAccountId, campaign_id: acid.campaignId, date_preset: "last_30d" }, (_result, text) =>
          assertAdInsightsResponse(_result, text, "No campaign insights found for the specified period.", "campaign")
        );
      },
    },
    {
      name: "meta_get_adset_insights",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        if (!acid.adAccountId) throw acid.adError ?? new Error("No ad account available");
        return runAcid("meta_get_adset_insights", { ad_account_id: acid.adAccountId, adset_id: acid.adsetId, date_preset: "last_30d" }, (_result, text) =>
          assertAdInsightsResponse(_result, text, "No ad set insights found for the specified period.", "ad set")
        );
      },
    },
    {
      name: "meta_get_ad_insights",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        if (!acid.adAccountId) throw acid.adError ?? new Error("No ad account available");
        return runAcid("meta_get_ad_insights", { ad_account_id: acid.adAccountId, ad_id: acid.adId, date_preset: "last_30d" }, (_result, text) =>
          assertAdInsightsResponse(_result, text, "No ad-level insights found for the specified period.", "ad-level")
        );
      },
    },
    {
      name: "meta_get_page_insights",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        return runAcid("meta_get_page_insights", { page_id: acid.pageId, period: "day" }, (_result, _text) => {
          // T8 replaced deprecated Page Insights defaults; low-engagement pages may return sparse output, so verify the invalid-metric regression is absent.
          assertOk(_result, ["(#100)", "valid insights metric", "page_impressions", "page_impressions_unique", "page_engaged_users", "page_fan_adds_unique", "page_fan_removes_unique", "page_video_views", "page_consumptions"]);
          return "deprecated Page Insights default-metric regression absent";
        });
      },
    },
    {
      name: "meta_get_post_insights",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        if (!acid.postId) throw new Error("No recent post available for post insights");
        return runAcid("meta_get_post_insights", { page_id: acid.pageId, post_id: acid.postId }, (_result, _text) => {
          // T9 replaced deprecated Post Insights defaults; sparse posts pass as long as Meta no longer reports invalid legacy post metrics.
          assertOk(_result, ["(#100)", "valid insights metric", "post_impressions", "post_impressions_unique", "post_impressions_paid", "post_impressions_organic", "post_impressions_fan", "post_impressions_viral", "post_impressions_nonviral", "post_engaged_users", "post_negative_feedback"]);
          return `deprecated Post Insights default-metric regression absent for ${acid.postId}`;
        });
      },
    },
    {
      name: "meta_get_page_fan_demographics",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        return runAcid("meta_get_page_fan_demographics", { page_id: acid.pageId }, (_result, text) => {
          assertOk(_result, ["page_fans_country", "page_fans_city", "page_fans_locale", "page_fans_gender_age"]);
          return text.includes("No demographic data available") ? "no demographic data; deprecated page_fans_* errors absent" : "follower demographic breakdown returned";
        });
      },
    },
    {
      name: "meta_get_instagram_account_insights",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        return runAcid("meta_get_instagram_account_insights", { ig_account_id: acid.igAccountId, metrics: ["accounts_engaged"], period: "day" }, (_result, text) => {
          assertOk(_result, ["should be specified with parameter metric_type=total_value"]);
          assertTextIncludes(text, "Auto-added metric_type=total_value");
          return "metric_type=total_value auto-detection hint present";
        });
      },
    },
    {
      name: "meta_get_page_videos",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        return runAcid("meta_get_page_videos", { page_id: acid.pageId }, (_result, text) => {
          assertOk(_result, ["maximum number of edge requests", "600"]);
          return text.includes("No videos found") ? "no videos; 600-edge limit regression absent" : "page videos returned without 600-edge limit error";
        });
      },
    },
    {
      name: "meta_list_offline_event_sets",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        if (!acid.adAccountId) throw acid.adError ?? new Error("No ad account available");
        return runAcid("meta_list_offline_event_sets", { ad_account_id: acid.adAccountId }, (_result, text) => {
          assertOk(_result, ["nonexisting field (offline_conversion_data_sets)"]);
          return text.includes("No offline custom conversions found") ? "no offline custom conversions; removed edge error absent" : "offline custom conversion summary returned";
        });
      },
    },
    {
      name: "meta_list_saved_audiences",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        if (!acid.adAccountId) throw acid.adError ?? new Error("No ad account available");
        return runAcid("meta_list_saved_audiences", { ad_account_id: acid.adAccountId }, (_result, text) => {
          assertOk(_result, ["nonexisting field (approximate_count)"]);
          return text.includes("No saved audiences found") ? "no saved audiences; approximate_count field error absent" : "saved audience summary returned";
        });
      },
    },
    {
      name: "meta_get_promotable_posts",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        return runAcid("meta_get_promotable_posts", { page_id: acid.pageId }, (_result, text) => {
          assertOk(_result, ["nonexisting field (promotable_posts)"]);
          return text.includes("No promotable posts found") ? "no promotable posts; removed edge error absent" : "feed eligibility summary returned";
        });
      },
    },
    {
      name: "meta_get_page_automated_responses",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        return runAcid("meta_get_page_automated_responses", { page_id: acid.pageId }, (_result, text) => {
          // T16 formats Messenger Profile settings under this heading; the old test asserted a pre-fix heading that is no longer emitted.
          assertOk(_result, ["instant_reply_message"]);
          assertTextIncludes(text, `# Automated Messaging Settings for Page \`${acid.pageId}\``);
          return "Messenger profile summary returned with automated messaging heading";
        });
      },
    },
    {
      name: "meta_get_instagram_broadcast_channels",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        const { result, text } = await callMarkdown("meta_get_instagram_broadcast_channels", { ig_account_id: acid.igAccountId });
        if (!result.isError || result.structuredContent?.code !== "IG_BROADCAST_CHANNELS_DEPRECATED") {
          throw new Error(`Expected IG_BROADCAST_CHANNELS_DEPRECATED structured error; got ${text}`);
        }
        return "structured IG_BROADCAST_CHANNELS_DEPRECATED response returned";
      },
    },
    {
      name: "meta_search_instagram_hashtag",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        return runAcid("meta_search_instagram_hashtag", { ig_account_id: acid.igAccountId, hashtag: "coffee", limit: 5 }, (_result, text) => {
          assertOk(_result, ["Please read documentation for supported fields"]);
          assertTextIncludes(text, "**Hashtag ID**");
          return "hashtag ID returned without fields error";
        });
      },
    },
    {
      name: "meta_get_instagram_media_children",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        if (!acid.carouselMediaId) throw new Error("No carousel Instagram media available for children test");
        return runAcid("meta_get_instagram_media_children", { media_id: acid.carouselMediaId }, (_result, text) => {
          assertOk(_result, ["Field is not available for Carousel children media", "carousel children"]);
          assertTextIncludes(text, "# Carousel Items");
          return `carousel children returned for ${acid.carouselMediaId}`;
        });
      },
    },
    {
      name: "meta_get_pixel_stats",
      run: async () => {
        const acid = await setupAcidContext(ctx);
        if (!acid.pixelId) throw acid.pixelError ?? new Error("No pixel available for pixel stats test");
        return runAcid("meta_get_pixel_stats", { pixel_id: acid.pixelId, aggregation: "event" }, (_result, text) => {
          assertOk(_result, ["aggregation must be one of the following values"]);
          return text.includes("No stats found") ? "no stats; aggregation=event accepted" : "pixel stats returned for aggregation=event";
        });
      },
    },
  ];
}

function buildWriteTests(ctx) {
  return [
    {
      name: "meta_create_post_journal_delete",
      requiredTools: ["meta_create_post", "meta_delete_post"],
      run: async () => {
        const acid = await setupAcidContext(ctx);
        const createResult = await callTool("meta_create_post", {
          page_id: acid.pageId,
          message: ACID_TEST_POST_TEXT,
          published: true,
          response_format: "json",
        });
        const createText = assertOk(createResult);
        const createJson = parseJsonResult(createResult, "meta_create_post");
        const postId = String(createJson.id ?? "");
        if (!postId) {
          throw new Error(`meta_create_post did not return post id: ${createText}`);
        }

        recordOrphan({ postId, parentId: acid.pageId, type: "post" });

        const deleteResult = await callTool("meta_delete_post", { page_id: acid.pageId, post_id: postId });
        const deleteText = assertOk(deleteResult);
        assertTextIncludes(deleteText, "deleted successfully");
        const scrubbed = scrubOrphan(postId);
        if (scrubbed < 1) {
          throw new Error(`Deleted ${postId}, but orphan journal scrub removed ${scrubbed} entries`);
        }
        return `created ${postId}, journaled before delete, deleted, and scrubbed from journal`;
      },
    },
    {
      name: "page_token_refresh_two_successive_writes",
      requiredTools: ["meta_create_post", "meta_delete_post"],
      run: async () => {
        const acid = await setupAcidContext(ctx);
        const first = await callTool("meta_create_post", {
          page_id: acid.pageId,
          message: ACID_TEST_POST_TEXT,
          published: false,
          response_format: "json",
        });
        const firstJson = parseJsonResult(first, "meta_create_post first draft");
        const firstPostId = String(firstJson.id ?? "");
        if (!firstPostId) throw new Error(`First draft post did not return id: ${resultText(first)}`);
        recordOrphan({ postId: firstPostId, parentId: acid.pageId, type: "post" });

        const second = await callTool("meta_create_post", {
          page_id: acid.pageId,
          message: ACID_TEST_POST_TEXT,
          published: false,
          response_format: "json",
        });
        const secondJson = parseJsonResult(second, "meta_create_post second draft");
        const secondPostId = String(secondJson.id ?? "");
        if (!secondPostId) throw new Error(`Second draft post did not return id: ${resultText(second)}`);
        recordOrphan({ postId: secondPostId, parentId: acid.pageId, type: "post" });

        for (const postId of [firstPostId, secondPostId]) {
          const deleteResult = await callTool("meta_delete_post", { page_id: acid.pageId, post_id: postId });
          const deleteText = assertOk(deleteResult, ["190/2069032"]);
          assertTextIncludes(deleteText, "deleted successfully");
          scrubOrphan(postId);
        }

        return `two consecutive page-token writes succeeded and were deleted (${firstPostId}, ${secondPostId})`;
      },
    },
    {
      name: "orphan_journal_empty",
      requiredTools: [],
      run: async () => {
        if (!journalIsEmpty()) {
          throw new Error(`Expected empty orphan journal; found ${countOrphans()} entries`);
        }
        return "orphan journal empty at end of write run";
      },
    },
  ];
}

export function recordOrphan({ postId, parentId, permalink, type = "post" }) {
  const details = { attempts: 1 };

  if (parentId !== undefined && parentId !== null) {
    details.parentId = String(parentId);
  }

  if (permalink !== undefined && permalink !== null) {
    details.permalink = String(permalink);
  }

  return appendOrphan(postId, type, details);
}

export function alertOperator({ postId, permalink, instruction }) {
  console.error("[live-acid] ORPHANED META POST REQUIRES MANUAL CLEANUP");
  console.error(`[live-acid] post_id: ${postId}`);
  console.error(`[live-acid] url: ${permalink}`);
  console.error(`[live-acid] instruction: ${instruction}`);
}

export function countOrphans() {
  return readOrphans().length;
}

export async function runReadTests(ctx) {
  const toolNames = selectedTools(ctx, READ_ONLY_TOOLS);
  const coverageFailure = validateToolCoverage("read-only", toolNames, ctx.registeredToolNames);
  if (coverageFailure) return coverageFailure;

  const tests = buildReadTests(ctx).filter((test) => toolNames.includes(test.name));
  return runAcidSuite("read-only", tests);
}

export async function runWriteTests(ctx) {
  const toolNames = selectedTools(ctx, WRITE_TOOLS);
  const coverageFailure = validateToolCoverage("write", toolNames, ctx.registeredToolNames);
  if (coverageFailure) return coverageFailure;

  const tests = buildWriteTests(ctx).filter((test) => {
    if (!ctx.selectedTool) return true;
    return test.name === ctx.selectedTool || test.requiredTools.includes(ctx.selectedTool);
  });
  return runAcidSuite("write", tests);
}

export async function runLiveAcid(argv = process.argv.slice(2), env = process.env) {
  if (!env.RUN_LIVE_ACID) {
    console.log("RUN_LIVE_ACID not set — skipping live acid suite (exit 0)");
    return 0;
  }

  loadDotEnv(env);

  let options;

  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[live-acid] ${error.message}`);
    printUsage();
    return 2;
  }

  if (options.help) {
    printUsage();
    return 0;
  }

  const ctx = {
    accessToken: env.META_ACCESS_TOKEN ?? "",
    businessId: DEFAULT_BUSINESS_ID,
    liveText: ACID_TEST_POST_TEXT,
    mode: options.mode,
    selectedTool: options.tool,
    registeredToolNames: new Set(),
  };

  try {
    console.error("[live-acid] starting MCP server via stdio");
    await startMcpServer();

    const toolsResult = await listTools();
    ctx.registeredToolNames = toolNamesFromResult(toolsResult);
    console.error(`[live-acid] MCP server listed ${ctx.registeredToolNames.size} tools`);

    if (!ctx.accessToken) {
      console.error("[live-acid] META_ACCESS_TOKEN not set; live acid suite cannot call Meta tools");
      return 1;
    }

    let totals = { pass: 0, fail: 0, tests: 0 };
    if (options.mode === "read-only") {
      totals = addTotals(totals, await runReadTests(ctx));
    } else {
      totals = addTotals(totals, await runWriteTests(ctx));
    }

    const orphanCount = countOrphans();

    if (totals.tests === 0) {
      console.error("[live-acid] no tests run; T23/T24 will populate actual tool coverage");
    }

    console.error(`[live-acid] ${totals.pass} pass / ${totals.fail} fail / ${orphanCount} orphans`);

    return totals.fail > 0 || orphanCount > 0 ? 1 : 0;
  } finally {
    await stopMcpServer();
  }
}

if (isMainModule()) {
  runLiveAcid()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error("[live-acid] fatal error");
      console.error(error?.stack ?? String(error));
      process.exitCode = 1;
    });
}

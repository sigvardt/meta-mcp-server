import axios, { AxiosError, type AxiosResponse } from "axios";
import { vi } from "vitest";

type GraphErrorBody = {
  error: {
    code: number;
    error_subcode?: number;
    message?: string;
    fbtrace_id?: string;
  };
};

type AxiosRequestRecord = {
  method: "get" | "post" | "delete";
  url: string;
  params?: unknown;
  body?: unknown;
};

type AllowlistSeedTarget = {
  businessIds?: Set<string>;
  pageIds?: Set<string>;
  adAccountIds?: Set<string>;
  igUserIds?: Set<string>;
};

const isVitest = Boolean(process.env.VITEST);

export const axiosInstance = axios;
export const requests: AxiosRequestRecord[] = [];

function installAxiosDefaults(): void {
  if (!isVitest) {
    return;
  }

  requests.length = 0;

  Object.assign(axiosInstance, {
    get: vi.fn((url: string, config?: { params?: unknown }) => {
      requests.push({ method: "get", url, params: config?.params });
      return Promise.resolve({ data: undefined } as never);
    }),
    post: vi.fn((url: string, body?: unknown) => {
      requests.push({ method: "post", url, body });
      return Promise.resolve({ data: undefined } as never);
    }),
    delete: vi.fn((url: string, config?: { params?: unknown }) => {
      requests.push({ method: "delete", url, params: config?.params });
      return Promise.resolve({ data: undefined } as never);
    }),
  });
}

installAxiosDefaults();

/**
 * Reset the shared axios mocks and return the mocked instance.
 * Import this module before the SUT so the hoisted `vi.mock("axios")` applies.
 */
export function mockAxios(): { axiosInstance: typeof axiosInstance; requests: AxiosRequestRecord[] } {
  installAxiosDefaults();
  return { axiosInstance, requests };
}

export function makeAxiosError<T>(payload: T): AxiosError<T> {
  const response = {
    data: payload,
    status: 400,
    statusText: "Bad Request",
    headers: {},
    config: {},
  } as AxiosResponse<T>;

  return new AxiosError("Request failed with status code 400", undefined, undefined, undefined, response);
}

export function makeGraphError(
  code: number,
  subcode?: number,
  message?: string,
  fbtraceId?: string
): AxiosError<GraphErrorBody> {
  return makeAxiosError({
    error: {
      code,
      error_subcode: subcode,
      message,
      fbtrace_id: fbtraceId,
    },
  });
}

export function mockSuccess<T>(data: T): { data: T } {
  return { data };
}

export function wireAuthService<T extends AllowlistSeedTarget>(authService: T): T {
  authService.businessIds ??= new Set<string>();
  authService.pageIds ??= new Set<string>();
  authService.adAccountIds ??= new Set<string>();
  authService.igUserIds ??= new Set<string>();

  authService.businessIds.add(TEST_BUSINESS_ID);
  authService.pageIds.add(TEST_PAGE_ID);
  authService.adAccountIds.add(TEST_AD_ACCOUNT_ID);
  authService.igUserIds.add(TEST_IG_USER_ID);

  return authService;
}

export const TEST_BUSINESS_ID = "833812607571849";
export const TEST_PAGE_ID = "9999999";
export const TEST_AD_ACCOUNT_ID = "act_9999999";
export const TEST_IG_USER_ID = "17841499999999999";

const UNIQUE_IMPRESSIONS_ERROR =
  "(#100) unique_impressions is not valid for fields param. please check https://developers.facebook.com/docs/marketing-api/reference/ads-insights/ for all valid values";
const PAGE_INSIGHTS_ERROR = "(#100) The value must be a valid insights metric";
const IG_METRIC_TYPE_ERROR =
  "(#100) The following metrics (accounts_engaged, total_interactions, likes, comments, shares, saves, profile_links_taps, follower_demographics) should be specified with parameter metric_type=total_value";
const OFFLINE_EVENT_SETS_ERROR = "(#100) Tried accessing nonexisting field (offline_conversion_data_sets)";
const SAVED_AUDIENCES_ERROR = "(#100) Tried accessing nonexisting field (approximate_count)";
const PROMOTABLE_POSTS_ERROR = "(#100) Tried accessing nonexisting field (promotable_posts)";
const AUTOMATED_RESPONSES_ERROR = "(#100) Tried accessing nonexisting field (instant_reply_message)";
const PIXEL_EVENTS_ERROR = "(#2500) Unknown path components: /test_events";
const BROADCAST_CHANNELS_ERROR = "(#2500) Unknown path components: /broadcast_channels";
const PLACE_SEARCH_ERROR = "(#12) Place Search API is deprecated for third parties effective v8.0";
const HASHTAG_FIELDS_ERROR = "(#100) Please read documentation for supported fields";
const MEDIA_CHILDREN_ERROR = "(#100) Field is not available for Carousel children media";
const PIXEL_STATS_ERROR =
  "(#100) For field 'stats': aggregation must be one of the following values: browser_type, custom_data_field, device_os, device_type, event, host, match_keys, had_pii, pixel_fire, event_detection_method, url, event_value_count, url_by_rule, event_total_counts, event_source, event_processing_results";
const PAGE_VIDEOS_ERROR =
  "Please reduce the amount of data you're asking for. The maximum number of edge requests for this object type and edge is 600";
const POST_REACTIONS_ERROR = "Access token is invalid or expired (190/2069032)";

/** @source issue #1 gist line 9 */
export const ERR_ACCOUNT_INSIGHTS_UNIQUE_IMPRESSIONS = makeGraphError(100, undefined, UNIQUE_IMPRESSIONS_ERROR);
/** @source issue #1 gist line 9 */
export const ERR_CAMPAIGN_INSIGHTS_UNIQUE_IMPRESSIONS = makeGraphError(100, undefined, UNIQUE_IMPRESSIONS_ERROR);
/** @source issue #1 gist line 9 */
export const ERR_ADSET_INSIGHTS_UNIQUE_IMPRESSIONS = makeGraphError(100, undefined, UNIQUE_IMPRESSIONS_ERROR);
/** @source issue #1 gist line 9 */
export const ERR_AD_INSIGHTS_UNIQUE_IMPRESSIONS = makeGraphError(100, undefined, UNIQUE_IMPRESSIONS_ERROR);

/** @source issue #1 gist line 11 */
export const ERR_PAGE_INSIGHTS_INVALID_METRIC = makeGraphError(100, undefined, PAGE_INSIGHTS_ERROR);
/** @source issue #1 gist line 11 */
export const ERR_PAGE_FAN_DEMOGRAPHICS_INVALID_METRIC = makeGraphError(100, undefined, PAGE_INSIGHTS_ERROR);
/** @source issue #1 gist line 11 */
export const ERR_POST_INSIGHTS_INVALID_METRIC = makeGraphError(100, undefined, PAGE_INSIGHTS_ERROR);

/** @source issue #1 gist line 13 */
export const ERR_IG_ACCOUNT_INSIGHTS_METRIC_TYPE_REQUIRED = makeGraphError(100, 2108006, IG_METRIC_TYPE_ERROR);

/** @source issue #1 gist line 21 */
export const ERR_OFFLINE_EVENT_SETS_FIELD_REMOVED = makeGraphError(100, undefined, OFFLINE_EVENT_SETS_ERROR);
/** @source issue #1 gist line 23 */
export const ERR_SAVED_AUDIENCES_FIELD_REMOVED = makeGraphError(100, undefined, SAVED_AUDIENCES_ERROR);
/** @source issue #1 gist line 25 */
export const ERR_PROMOTABLE_POSTS_FIELD_REMOVED = makeGraphError(100, undefined, PROMOTABLE_POSTS_ERROR);
/** @source issue #1 gist line 27 */
export const ERR_PAGE_AUTOMATED_RESPONSES_FIELD_REMOVED = makeGraphError(100, undefined, AUTOMATED_RESPONSES_ERROR);

/** @source issue #1 gist line 31 */
export const ERR_PIXEL_EVENTS_UNKNOWN_PATH = makeGraphError(2500, undefined, PIXEL_EVENTS_ERROR);
/** @source issue #1 gist line 33 */
export const ERR_IG_BROADCAST_CHANNELS_UNKNOWN_PATH = makeGraphError(2500, undefined, BROADCAST_CHANNELS_ERROR);

/** @source issue #1 gist line 37 */
export const ERR_PLACE_SEARCH_DEPRECATED = makeGraphError(12, undefined, PLACE_SEARCH_ERROR);

/** @source issue #1 gist line 41 */
export const ERR_IG_HASHTAG_SUPPORTED_FIELDS = makeGraphError(100, undefined, HASHTAG_FIELDS_ERROR);
/** @source issue #1 gist line 43 */
export const ERR_IG_MEDIA_CHILDREN_FIELD_NOT_AVAILABLE = makeGraphError(100, undefined, MEDIA_CHILDREN_ERROR);

/** @source issue #1 gist line 47 */
export const ERR_PIXEL_STATS_INVALID_AGGREGATION = makeGraphError(100, undefined, PIXEL_STATS_ERROR);
/** @source issue #1 gist line 49 */
export const ERR_PAGE_VIDEOS_THUMBNAILS_LIMIT = makeGraphError(100, undefined, PAGE_VIDEOS_ERROR);
/** @source issue #1 gist line 51 */
export const ERR_POST_REACTIONS_PAGE_TOKEN_INVALID = makeGraphError(190, 2069032, POST_REACTIONS_ERROR);

export const documentedErrors = new Map<string, AxiosError<GraphErrorBody>>([
  ["errorAccountInsightsUniqueImpressions", ERR_ACCOUNT_INSIGHTS_UNIQUE_IMPRESSIONS],
  ["errorCampaignInsightsUniqueImpressions", ERR_CAMPAIGN_INSIGHTS_UNIQUE_IMPRESSIONS],
  ["errorAdsetInsightsUniqueImpressions", ERR_ADSET_INSIGHTS_UNIQUE_IMPRESSIONS],
  ["errorAdInsightsUniqueImpressions", ERR_AD_INSIGHTS_UNIQUE_IMPRESSIONS],
  ["errorPageInsightsInvalidMetric", ERR_PAGE_INSIGHTS_INVALID_METRIC],
  ["errorPageFanDemographicsInvalidMetric", ERR_PAGE_FAN_DEMOGRAPHICS_INVALID_METRIC],
  ["errorPostInsightsInvalidMetric", ERR_POST_INSIGHTS_INVALID_METRIC],
  ["errorIGMetricType", ERR_IG_ACCOUNT_INSIGHTS_METRIC_TYPE_REQUIRED],
  ["errorOfflineEventSets", ERR_OFFLINE_EVENT_SETS_FIELD_REMOVED],
  ["errorSavedAudiencesField", ERR_SAVED_AUDIENCES_FIELD_REMOVED],
  ["errorPromotablePosts", ERR_PROMOTABLE_POSTS_FIELD_REMOVED],
  ["errorAutomatedResponses", ERR_PAGE_AUTOMATED_RESPONSES_FIELD_REMOVED],
  ["errorPixelEvents", ERR_PIXEL_EVENTS_UNKNOWN_PATH],
  ["errorBroadcastChannels", ERR_IG_BROADCAST_CHANNELS_UNKNOWN_PATH],
  ["errorPlaceSearch", ERR_PLACE_SEARCH_DEPRECATED],
  ["errorInstagramHashtagFields", ERR_IG_HASHTAG_SUPPORTED_FIELDS],
  ["errorInstagramMediaChildrenFields", ERR_IG_MEDIA_CHILDREN_FIELD_NOT_AVAILABLE],
  ["errorPixelStatsAggregation", ERR_PIXEL_STATS_INVALID_AGGREGATION],
  ["errorPageVideosLimit", ERR_PAGE_VIDEOS_THUMBNAILS_LIMIT],
  ["errorPostReactionsPageTokenInvalid", ERR_POST_REACTIONS_PAGE_TOKEN_INVALID],
]);

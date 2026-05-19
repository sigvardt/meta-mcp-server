import axios, { AxiosError } from "axios";
import { GRAPH_API_BASE, THREADS_API_BASE } from "../constants.js";
import { BusinessAuthorizationService, inferEdgeChildType } from "./business-authorization.js";
import { isMetaDevRateLimit } from "./utils.js";

type MetaErrorResponse = {
  error?: {
    code?: number;
    error_subcode?: number;
  };
};

type PageTokenResponse = {
  access_token: string;
};

export class MetaApiClient {
  private static readonly PAGE_TOKEN_REFRESH_COOLDOWN_MS = 5000;
  private static readonly RATE_LIMIT_RETRY_BACKOFF_MS = [30_000, 60_000, 120_000] as const;
  private static readonly RATE_LIMIT_MIN_PACE_MS_DEFAULT = 5_000;

  private readonly userToken: string;
  private readonly threadsToken: string | undefined;
  private readonly pageTokenCache = new Map<string, string>();
  private readonly pageTokenLastRefreshAt: Map<string, number> = new Map();
  private permanentlyFailedPaths: Map<string, AxiosError> = new Map();
  private pageRateLimitState: { lastCallAt: number; inflight: Promise<void> | null } = {
    lastCallAt: Number.NEGATIVE_INFINITY,
    inflight: null,
  };
  private authService: BusinessAuthorizationService | undefined;

  constructor(userToken: string, threadsToken?: string) {
    this.userToken = userToken;
    this.threadsToken = threadsToken;
  }

  attachAuthService(service: BusinessAuthorizationService): void {
    this.authService = service;
  }

  requireUserToken(): void {
    if (!this.userToken) {
      throw new Error(
        "META_ACCESS_TOKEN is not configured. " +
          "Add it to your MCP server config under env: { \"META_ACCESS_TOKEN\": \"your_token\" }. " +
          "Get a token from https://developers.facebook.com/tools/explorer/"
      );
    }
  }

  async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requireUserToken();
    this.assertPathAllowed(path, params);
    const data = await this.withRateLimitHandling(`GET ${path}`, async () => {
      const response = await axios.get(`${GRAPH_API_BASE}${path}`, {
        params: { access_token: this.userToken, ...params },
        timeout: 30000,
      });
      return response.data as T;
    });
    this.addAllowedIdsFromResponse(path, params, data);
    return data;
  }

  /**
   * Bootstrap-only Graph API GET. Skips authorization allowlists and page-token retry hooks.
   */
  async getRaw<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requireUserToken();
    const response = await axios.get(`${GRAPH_API_BASE}${path}`, {
      params: { access_token: this.userToken, ...params },
      timeout: 30000,
    });
    return response.data as T;
  }

  async getWithToken<T>(
    path: string,
    token: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    this.assertPathAllowed(path, params);
    const data = await this.withRateLimitHandling(`GET ${path}`, () =>
      this.withPageTokenRefresh(path, token, async (accessToken) => {
        const response = await axios.get(`${GRAPH_API_BASE}${path}`, {
          params: { access_token: accessToken, ...params },
          timeout: 30000,
        });
        return response.data as T;
      })
    );
    this.addAllowedIdsFromResponse(path, params, data);
    return data;
  }

  async post<T>(
    path: string,
    fields: Record<string, unknown> = {},
    token?: string
  ): Promise<T> {
    this.requireUserToken();
    this.assertPathAllowed(path, fields);
    return this.withRateLimitHandling(`POST ${path}`, () =>
      this.withPageTokenRefresh(path, token, async (accessToken) => {
        const body = this.buildFormBody(fields, accessToken ?? this.userToken);
        const response = await axios.post(`${GRAPH_API_BASE}${path}`, body, {
          timeout: 30000,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        return response.data as T;
      })
    );
  }

  async delete<T>(
    path: string,
    token?: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    this.requireUserToken();
    this.assertPathAllowed(path, params);
    return this.withRateLimitHandling(`DELETE ${path}`, () =>
      this.withPageTokenRefresh(path, token, async (accessToken) => {
        const response = await axios.delete(`${GRAPH_API_BASE}${path}`, {
          params: { access_token: accessToken ?? this.userToken, ...params },
          timeout: 30000,
        });
        return response.data as T;
      })
    );
  }

  private assertPathAllowed(path: string, params: Record<string, unknown>): void {
    this.authService?.assertPathAllowed(path, params);
  }

  private addAllowedIdsFromResponse(
    path: string,
    params: Record<string, unknown>,
    responseData: unknown
  ): void {
    if (!this.authService) return;

    const edgeChildType = inferEdgeChildType(path);
    if (edgeChildType) {
      this.addEdgeResponseIds(edgeChildType, responseData);
      return;
    }

    const singleObjectType = this.inferSingleObjectType(path, params);
    if (!singleObjectType || !isRecord(responseData)) return;
    this.addAllowedId(singleObjectType, responseData.id);
  }

  private addEdgeResponseIds(childType: string, responseData: unknown): void {
    if (Array.isArray(responseData)) {
      for (const item of responseData) {
        if (isRecord(item)) this.addAllowedId(childType, item.id);
      }
      return;
    }

    if (!isRecord(responseData)) return;

    if (Array.isArray(responseData.data)) {
      for (const item of responseData.data) {
        if (isRecord(item)) this.addAllowedId(childType, item.id);
      }
      return;
    }

    for (const item of Object.values(responseData)) {
      if (isRecord(item)) this.addAllowedId(childType, item.id);
    }
  }

  private addAllowedId(type: string, id: unknown): void {
    if (typeof id !== "string" && typeof id !== "number" && typeof id !== "bigint") return;
    this.authService?.addAllowed(type, String(id));
  }

  private inferSingleObjectType(path: string, params: Record<string, unknown>): string | null {
    if (!/^\/?(?:v\d+\.\d+\/)?\d+(?:\?|$)/.test(path.trim())) return null;

    const fields = new Set<string>();
    for (const field of this.getRequestedFields(path, params)) {
      fields.add(field);
    }

    if (fields.has("adset_id") && fields.has("campaign_id")) return "ad_ad";
    if (fields.has("campaign_id") && hasAnyField(fields, "optimization_goal", "billing_event", "targeting")) {
      return "ad_adset";
    }
    if (hasAnyField(fields, "objective", "budget_remaining", "daily_budget", "lifetime_budget")) {
      return "ad_campaign";
    }
    if (hasAnyField(fields, "account_id", "account_status", "amount_spent")) return "ad_account";
    if (hasAnyField(fields, "parent_id", "media_product_type", "media_type")) return "instagram_media";
    if (hasAnyField(fields, "retailer_id", "sale_price", "inventory")) return "product";

    return null;
  }

  private getRequestedFields(path: string, params: Record<string, unknown>): string[] {
    const fieldValues = [params.fields];
    const queryIndex = path.indexOf("?");
    if (queryIndex >= 0) {
      fieldValues.push(new URLSearchParams(path.slice(queryIndex + 1)).get("fields"));
    }

    return fieldValues.flatMap((value) => parseFieldNames(value));
  }

  private buildFormBody(fields: Record<string, unknown>, token: string): URLSearchParams {
    const body = new URLSearchParams();
    body.append("access_token", token);
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) {
        body.append(
          key,
          typeof value === "object" ? JSON.stringify(value) : String(value)
        );
      }
    }
    return body;
  }

  private async withRateLimitHandling<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const breakerKey = this.getRateLimitBreakerKey(label);
    const cachedError = this.permanentlyFailedPaths.get(breakerKey);
    if (cachedError) throw cachedError;

    const maxRetries = this.getRateLimitRetries();
    let attempt = 0;

    while (true) {
      await this.waitForPaceSlot();

      try {
        return await fn();
      } catch (error) {
        if (!isMetaDevRateLimit(error)) {
          throw error;
        }

        if (attempt >= maxRetries) {
          if (maxRetries > 0) {
            this.permanentlyFailedPaths.set(breakerKey, error as AxiosError);
          }
          throw error;
        }

        const backoffMs = MetaApiClient.RATE_LIMIT_RETRY_BACKOFF_MS[attempt];
        const retryNumber = attempt + 1;
        attempt = retryNumber;
        console.error(
          `[meta-api] Meta rate-limit for ${label}; retrying in ${backoffMs / 1000}s (${retryNumber}/${maxRetries})`
        );
        await this.sleep(backoffMs);
      }
    }
  }

  private getRateLimitBreakerKey(label: string): string {
    const separatorIndex = label.indexOf(" ");
    if (separatorIndex === -1) return this.stripQueryString(label);

    const method = label.slice(0, separatorIndex);
    const path = label.slice(separatorIndex + 1);
    return `${method} ${this.stripQueryString(path)}`;
  }

  private stripQueryString(path: string): string {
    const queryIndex = path.indexOf("?");
    return queryIndex === -1 ? path : path.slice(0, queryIndex);
  }

  private async waitForPaceSlot(): Promise<void> {
    while (this.pageRateLimitState.inflight) {
      await this.pageRateLimitState.inflight;
    }

    const paceMs = this.getRateLimitPaceMs();
    const now = Date.now();
    const elapsed = this.pageRateLimitState.lastCallAt === 0 && now > 0
      ? Number.POSITIVE_INFINITY
      : now - this.pageRateLimitState.lastCallAt;
    if (paceMs > 0 && elapsed < paceMs) {
      const waitMs = paceMs - elapsed;
      const inflight = this.sleep(waitMs);
      this.pageRateLimitState.inflight = inflight;
      try {
        await inflight;
      } finally {
        if (this.pageRateLimitState.inflight === inflight) {
          this.pageRateLimitState.inflight = null;
        }
      }
    }

    this.pageRateLimitState.lastCallAt = Date.now();
  }

  private getRateLimitPaceMs(): number {
    return this.parseNonNegativeIntegerEnv(
      "META_RATE_LIMIT_PACE_MS",
      MetaApiClient.RATE_LIMIT_MIN_PACE_MS_DEFAULT
    );
  }

  private getRateLimitRetries(): number {
    const retries = this.parseNonNegativeIntegerEnv(
      "META_RATE_LIMIT_RETRIES",
      MetaApiClient.RATE_LIMIT_RETRY_BACKOFF_MS.length
    );
    return Math.min(retries, MetaApiClient.RATE_LIMIT_RETRY_BACKOFF_MS.length);
  }

  private parseNonNegativeIntegerEnv(name: string, fallback: number): number {
    const value = process.env[name];
    if (value === undefined || value === "") {
      return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async refreshPageToken(pageId: string): Promise<string> {
    this.requireUserToken();
    const response = await axios.get<PageTokenResponse>(`${GRAPH_API_BASE}/${pageId}`, {
      params: { access_token: this.userToken, fields: "access_token" },
      timeout: 30000,
    });
    const token = response.data.access_token;
    this.pageTokenCache.set(pageId, token);
    return token;
  }

  private async withPageTokenRefresh<T>(
    path: string,
    token: string | undefined,
    request: (token: string | undefined) => Promise<T>
  ): Promise<T> {
    let didRetry = false;

    try {
      return await request(token);
    } catch (error) {
      const pageId = this.getCachedPageIdForToken(path, token);
      if (didRetry || !pageId || !this.isExpiredPageTokenError(error)) {
        throw error;
      }

      const lastRefreshAt = this.pageTokenLastRefreshAt.get(pageId);
      if (
        lastRefreshAt !== undefined &&
        Date.now() - lastRefreshAt < MetaApiClient.PAGE_TOKEN_REFRESH_COOLDOWN_MS
      ) {
        throw error;
      }

      didRetry = true;
      try {
        const freshToken = await this.refreshPageToken(pageId);
        this.pageTokenLastRefreshAt.set(pageId, Date.now());
        return await request(freshToken);
      } catch {
        throw error;
      }
    }
  }

  private getCachedPageIdForToken(path: string, token: string | undefined): string | undefined {
    if (!token) return undefined;
    const pageId = path.match(/^\/(\d+)(?:\/|$)/)?.[1];
    return pageId && this.pageTokenCache.get(pageId) === token ? pageId : undefined;
  }

  private isExpiredPageTokenError(error: unknown): boolean {
    const apiError = (error as AxiosError<MetaErrorResponse>).response?.data?.error;
    return apiError?.code === 190 && apiError.error_subcode === 2069032;
  }

  // Page token management
  cachePageToken(pageId: string, token: string): void {
    this.pageTokenCache.set(pageId, token);
  }

  getPageToken(pageId: string): string | undefined {
    return this.pageTokenCache.get(pageId);
  }

  requirePageToken(pageId: string): string {
    const token = this.pageTokenCache.get(pageId);
    if (!token) {
      throw new Error(
        `No access token cached for page ${pageId}. ` +
          `Call meta_list_pages first to load page tokens, then use the page ID from those results.`
      );
    }
    return token;
  }

  getUserToken(): string {
    return this.userToken;
  }

  getPageTokenCount(): number {
    return this.pageTokenCache.size;
  }

  // Threads API methods (different base URL)
  requireThreadsToken(): string {
    if (!this.threadsToken) {
      throw new Error(
        "No THREADS_ACCESS_TOKEN configured. " +
          "Set it in your MCP config env to use Threads tools."
      );
    }
    return this.threadsToken;
  }

  hasThreadsToken(): boolean {
    return !!this.threadsToken;
  }

  async threadsGet<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const token = this.requireThreadsToken();
    const response = await axios.get(`${THREADS_API_BASE}${path}`, {
      params: { access_token: token, ...params },
      timeout: 30000,
    });
    return response.data as T;
  }

  async threadsPost<T>(path: string, fields: Record<string, unknown> = {}): Promise<T> {
    const token = this.requireThreadsToken();
    const body = new URLSearchParams();
    body.append("access_token", token);
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) {
        body.append(
          key,
          typeof value === "object" ? JSON.stringify(value) : String(value)
        );
      }
    }
    const response = await axios.post(`${THREADS_API_BASE}${path}`, body, {
      timeout: 30000,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return response.data as T;
  }

  async threadsDelete<T>(path: string): Promise<T> {
    const token = this.requireThreadsToken();
    const response = await axios.delete(`${THREADS_API_BASE}${path}`, {
      params: { access_token: token },
      timeout: 30000,
    });
    return response.data as T;
  }

  /**
   * Polls a container's status until it's FINISHED or max attempts reached.
   * Used for video processing in Instagram (reels, stories, carousels) and Threads.
   * @param containerId Container ID to poll
   * @param platform 'instagram' or 'threads' — determines API and status field name
   * @param maxAttempts Maximum number of 5-second intervals to wait (default 12 = 60s)
   * @returns The final status string
   */
  async pollContainerStatus(
    containerId: string,
    platform: "instagram" | "threads" = "instagram",
    maxAttempts = 12
  ): Promise<string> {
    const statusField = platform === "threads" ? "status" : "status_code";
    let statusCode = "IN_PROGRESS";

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Check first, then sleep — saves 5s on fast completions
      const result = platform === "threads"
        ? await this.threadsGet<Record<string, string>>(`/${containerId}`, { fields: statusField })
        : await this.get<Record<string, string>>(`/${containerId}`, { fields: statusField });
      statusCode = result[statusField] ?? "IN_PROGRESS";
      if (statusCode !== "IN_PROGRESS") break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    return statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAnyField(fields: Set<string>, ...names: string[]): boolean {
  return names.some((name) => fields.has(name));
}

function parseFieldNames(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => parseFieldNames(entry));
  if (typeof value !== "string") return [];

  return value
    .split(/[,{()}\s]+/)
    .map((field) => field.trim().toLowerCase())
    .filter(Boolean);
}

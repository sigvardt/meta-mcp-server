import { GRAPH_API_BASE } from "../constants.js";

const KNOWN_RESOURCE_TYPES = [
  "businesses",
  "ad_accounts",
  "pages",
  "instagram_accounts",
  "pixels",
  "product_catalogs",
  "system_users",
] as const;

type BootstrapMode = "fail-closed" | "warn";
type GraphBootstrapClient = {
  getRaw<T>(path: string, params?: Record<string, unknown>): Promise<T>;
};
type GraphResource = {
  id?: unknown;
  instagram_business_account?: { id?: unknown } | null;
};
type GraphEdgeResponse = {
  data?: GraphResource[];
  paging?: {
    cursors?: {
      after?: string;
    };
  };
};

export const BYPASS_PATHS = [
  /^\/me$/, // rationale: current user identity is token-scoped, not resource-scoped.
  /^\/me\/accounts$/, // rationale: page discovery is token-scoped and feeds bootstrap/user setup.
  /^\/me\/adaccounts$/, // rationale: ad-account discovery is token-scoped and feeds bootstrap/user setup.
  /^\/me\/businesses$/, // rationale: business discovery is token-scoped and may be used before bootstrap.
  /^\/me\/permissions$/, // rationale: permission inspection has no business resource ID.
  /^\/search$/, // rationale: search/discovery endpoints return candidate metadata, not scoped resources.
  /^\/debug_token$/, // rationale: token introspection validates credentials rather than business data.
  /^\/oauth\//, // rationale: OAuth flows exchange credentials before resource authorization applies.
];

export const EDGE_CHILD_TYPE_MAP = [
  // rationale: campaign listing returns campaign IDs owned by an allowed ad account.
  { pattern: /^\/act_\d+\/campaigns$/, childType: "ad_campaign" },
  // rationale: ad-set listing returns ad-set IDs owned by an allowed ad account.
  { pattern: /^\/act_\d+\/adsets$/, childType: "ad_adset" },
  // rationale: ad listing returns ad IDs owned by an allowed ad account.
  { pattern: /^\/act_\d+\/ads$/, childType: "ad_ad" },
  // rationale: campaign listing also accepts numeric ad-account IDs after act_ normalization.
  { pattern: /^\/\d+\/campaigns$/, childType: "ad_campaign" },
  // rationale: ad-set listing also accepts numeric ad-account IDs after act_ normalization.
  { pattern: /^\/\d+\/adsets$/, childType: "ad_adset" },
  // rationale: ad listing also accepts numeric ad-account IDs after act_ normalization.
  { pattern: /^\/\d+\/ads$/, childType: "ad_ad" },
  // rationale: page posts are child post IDs returned from an allowed page.
  { pattern: /^\/\d+\/posts$/, childType: "post" },
  // rationale: page feed entries are post IDs returned from an allowed page token flow.
  { pattern: /^\/\d+\/feed$/, childType: "post" },
  // rationale: Instagram account media lists return media IDs owned by an allowed IG account.
  { pattern: /^\/\d+\/media$/, childType: "instagram_media" },
  // rationale: carousel children return media IDs under an allowed parent media object.
  { pattern: /^\/\d+\/children$/, childType: "instagram_media" },
  // rationale: hashtag top-media edges return media IDs after an allowed hashtag lookup.
  { pattern: /^\/\d+\/top_media$/, childType: "instagram_media" },
  // rationale: hashtag recent-media edges return media IDs after an allowed hashtag lookup.
  { pattern: /^\/\d+\/recent_media$/, childType: "instagram_media" },
  // rationale: hashtag search returns hashtag IDs scoped by an allowed Instagram user context.
  { pattern: /^\/ig_hashtag_search$/, childType: "instagram_hashtag" },
  // rationale: owned pixel discovery returns pixel IDs under an allowed business.
  { pattern: /^\/\d+\/owned_pixels$/, childType: "ad_pixel" },
  // rationale: adspixels discovery returns pixel IDs under an allowed business or ad account.
  { pattern: /^\/\d+\/adspixels$/, childType: "ad_pixel" },
  // rationale: owned page discovery returns page IDs under an allowed business.
  { pattern: /^\/\d+\/owned_pages$/, childType: "page" },
  // rationale: client page discovery returns page IDs under an allowed business.
  { pattern: /^\/\d+\/client_pages$/, childType: "page" },
  // rationale: owned ad-account discovery returns ad-account IDs under an allowed business.
  { pattern: /^\/\d+\/owned_ad_accounts$/, childType: "ad_account" },
  // rationale: client ad-account discovery returns ad-account IDs under an allowed business.
  { pattern: /^\/\d+\/client_ad_accounts$/, childType: "ad_account" },
  // rationale: owned catalog discovery returns catalog IDs under an allowed business.
  { pattern: /^\/\d+\/owned_product_catalogs$/, childType: "product_catalog" },
  // rationale: client catalog discovery returns catalog IDs under an allowed business.
  { pattern: /^\/\d+\/client_product_catalogs$/, childType: "product_catalog" },
  // rationale: product listing returns product IDs under an allowed catalog.
  { pattern: /^\/\d+\/products$/, childType: "product" },
] as const;

export function inferEdgeChildType(path: string): string | null {
  const normalizedPath = normalizeGraphPath(path).pathname;
  return EDGE_CHILD_TYPE_MAP.find(({ pattern }) => pattern.test(normalizedPath))?.childType ?? null;
}

export class BusinessAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessAuthorizationError";
    Object.setPrototypeOf(this, BusinessAuthorizationError.prototype);
  }
}

export class BusinessAuthorizationService {
  private allowedIds: Map<string, Set<string>>;
  private readonly seedBusinessIds: Set<string>;
  private readonly bootstrapMode: BootstrapMode;
  private readonly unrestricted: boolean;

  constructor() {
    const configuredBusinessIds = process.env.META_ALLOWED_BUSINESS_IDS?.trim();
    this.unrestricted = !configuredBusinessIds;

    this.seedBusinessIds = new Set(
      splitIdValues(configuredBusinessIds ?? "").map((id) => normalizeResourceId(id))
    );

    this.bootstrapMode =
      process.env.META_AUTH_BOOTSTRAP_MODE === "warn" ? "warn" : "fail-closed";
    this.allowedIds = this.createSeedAllowlist();
  }

  async bootstrap(client: GraphBootstrapClient): Promise<void> {
    if (this.unrestricted) return;

    const bootstrappedIds = this.createSeedAllowlist();

    try {
      for (const businessId of this.seedBusinessIds) {
        await this.addEdgeIds(client, bootstrappedIds, businessId, "owned_ad_accounts", "ad_accounts");
        await this.addEdgeIds(client, bootstrappedIds, businessId, "client_ad_accounts", "ad_accounts");

        const ownedPages = await this.fetchEdgeResources(
          client,
          businessId,
          "owned_pages",
          "id,instagram_business_account"
        );
        this.addResources(bootstrappedIds, "pages", ownedPages);
        for (const page of ownedPages) {
          if (typeof page.instagram_business_account?.id === "string") {
            this.addToMap(bootstrappedIds, "instagram_accounts", page.instagram_business_account.id);
          }
        }

        await this.addEdgeIds(client, bootstrappedIds, businessId, "client_pages", "pages");
        await this.addEdgeIds(
          client,
          bootstrappedIds,
          businessId,
          "owned_instagram_accounts",
          "instagram_accounts"
        );
        await this.addEdgeIds(client, bootstrappedIds, businessId, "adspixels", "pixels");
        await this.addEdgeIds(client, bootstrappedIds, businessId, "owned_pixels", "pixels");
        await this.addEdgeIds(
          client,
          bootstrappedIds,
          businessId,
          "owned_product_catalogs",
          "product_catalogs"
        );
        await this.addEdgeIds(
          client,
          bootstrappedIds,
          businessId,
          "client_product_catalogs",
          "product_catalogs"
        );
        await this.addEdgeIds(client, bootstrappedIds, businessId, "system_users", "system_users");
      }

      this.allowedIds = bootstrappedIds;
    } catch (error) {
      const message = `Business authorization bootstrap failed: ${describeError(error)}`;
      this.allowedIds = this.createSeedAllowlist();

      if (this.bootstrapMode === "warn") {
        console.error(
          `${message}. Keeping seed-only allowlist. Set META_AUTH_BOOTSTRAP_MODE=fail-closed to block startup, or verify META_ALLOWED_BUSINESS_IDS and Meta API access.`
        );
        return;
      }

      throw new Error(
        `${message}. Set META_AUTH_BOOTSTRAP_MODE=warn to start with only META_ALLOWED_BUSINESS_IDS, or fix Meta API access for the configured business IDs.`
      );
    }
  }

  extractResourceIds(path: string, params: Record<string, unknown>): { type: string; id: string }[] {
    const normalizedPath = normalizeGraphPath(path);
    const ids: { type: string; id: string }[] = [];
    const seen = new Set<string>();

    const addId = (type: string, rawId: string): void => {
      const id = normalizeResourceId(rawId);
      if (!id) return;
      const seenKey = `${type}:${id}`;
      if (seen.has(seenKey)) return;
      ids.push({ type, id });
      seen.add(seenKey);
    };

    const segments = normalizedPath.pathname
      .split("/")
      .map((segment) => safeDecode(segment))
      .filter(Boolean);

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment || !isMetaId(segment)) continue;
      addId(inferPathType(segments, index), segment);
    }

    for (const [key, value] of normalizedPath.queryParams) {
      this.addQueryParamIds(key, value, addId);
    }
    for (const [key, value] of Object.entries(params)) {
      this.addQueryParamIds(key, value, addId);
    }

    return ids;
  }

  isAllowed(id: string): boolean {
    if (this.unrestricted) return true;

    const normalizedId = normalizeResourceId(id);
    if (!normalizedId) return false;
    if (this.seedBusinessIds.has(normalizedId)) return true;

    for (const allowedSet of this.allowedIds.values()) {
      if (allowedSet.has(normalizedId)) return true;
    }
    return false;
  }

  assertPathAllowed(path: string, params: Record<string, unknown>): void {
    if (this.unrestricted) return;

    const normalizedPath = normalizeGraphPath(path);
    if (BYPASS_PATHS.some((pattern) => pattern.test(normalizedPath.pathname))) {
      return;
    }

    const resourceIds = this.extractResourceIds(path, params);
    if (resourceIds.length === 0) {
      console.error(
        `BusinessAuthorizationService: no resource IDs found in ${normalizedPath.pathname}; allowing call for now. Add an explicit BYPASS_PATHS entry if this endpoint is token-scoped.`
      );
      return;
    }

    const denied = resourceIds.find((resource) => !this.isAllowed(resource.id));
    if (denied) {
      throw new BusinessAuthorizationError(
        `Resource ${denied.id} (type=${denied.type}) not in allowed business scope. Set META_ALLOWED_BUSINESS_IDS to override.`
      );
    }
  }

  addAllowed(type: string, id: string): void {
    this.addToMap(this.allowedIds, normalizeResourceType(type), id);
  }

  removeAllowed(type: string, id: string): void {
    this.allowedIds.get(normalizeResourceType(type))?.delete(normalizeResourceId(id));
  }

  getSnapshot(): Record<string, string[]> {
    if (this.unrestricted) {
      return { all: ["*"] };
    }

    const snapshot: Record<string, string[]> = {};
    for (const [type, ids] of this.allowedIds.entries()) {
      snapshot[type] = Array.from(ids).sort();
    }
    return snapshot;
  }

  private async addEdgeIds(
    client: GraphBootstrapClient,
    allowedIds: Map<string, Set<string>>,
    businessId: string,
    edge: string,
    type: string
  ): Promise<void> {
    const resources = await this.fetchEdgeResources(client, businessId, edge, "id");
    this.addResources(allowedIds, type, resources);
  }

  private addResources(
    allowedIds: Map<string, Set<string>>,
    type: string,
    resources: GraphResource[]
  ): void {
    for (const resource of resources) {
      if (typeof resource.id === "string" || typeof resource.id === "number") {
        this.addToMap(allowedIds, type, String(resource.id));
      }
    }
  }

  private async fetchEdgeResources(
    client: GraphBootstrapClient,
    businessId: string,
    edge: string,
    fields: string
  ): Promise<GraphResource[]> {
    const resources: GraphResource[] = [];
    let after: string | undefined;

    do {
      const params: Record<string, unknown> = { fields, limit: 200 };
      if (after) params.after = after;

      try {
        const response = await client.getRaw<GraphEdgeResponse>(`/${businessId}/${edge}`, params);
        if (Array.isArray(response.data)) {
          resources.push(...response.data);
        }
        const nextAfter = response.paging?.cursors?.after;
        after = nextAfter && nextAfter !== after ? nextAfter : undefined;
      } catch (error) {
        const status = getErrorStatus(error);
        if (status !== undefined && status >= 400 && status < 500) {
          console.error(
            `BusinessAuthorizationService: skipping /${businessId}/${edge}; Meta returned HTTP ${status}. Some business edges are unavailable for some tokens.`
          );
          return resources;
        }
        throw new Error(`fetching /${businessId}/${edge} failed: ${describeError(error)}`);
      }
    } while (after);

    return resources;
  }

  private addQueryParamIds(
    key: string,
    value: unknown,
    addId: (type: string, id: string) => void
  ): void {
    const type = inferQueryType(key);
    if (!type) return;

    for (const id of valueToIds(value)) {
      addId(type, id);
    }
  }

  private createSeedAllowlist(): Map<string, Set<string>> {
    const allowlist = new Map<string, Set<string>>();
    for (const type of KNOWN_RESOURCE_TYPES) {
      allowlist.set(type, new Set<string>());
    }
    for (const businessId of this.seedBusinessIds) {
      this.addToMap(allowlist, "businesses", businessId);
    }
    return allowlist;
  }

  private addToMap(allowedIds: Map<string, Set<string>>, type: string, id: string): void {
    const normalizedId = normalizeResourceId(id);
    if (!normalizedId) return;

    const normalizedType = normalizeResourceType(type);
    const allowedSet = allowedIds.get(normalizedType) ?? new Set<string>();
    allowedSet.add(normalizedId);
    allowedIds.set(normalizedType, allowedSet);
  }
}

function normalizeGraphPath(path: string): { pathname: string; queryParams: URLSearchParams } {
  const trimmedPath = path.trim();
  let pathAndQuery = trimmedPath;

  try {
    const url = new URL(trimmedPath);
    pathAndQuery = `${url.pathname}${url.search}`;
  } catch {
    if (trimmedPath.startsWith(GRAPH_API_BASE)) {
      pathAndQuery = trimmedPath.slice(GRAPH_API_BASE.length) || "/";
    }
  }

  const queryIndex = pathAndQuery.indexOf("?");
  const rawPathname = queryIndex >= 0 ? pathAndQuery.slice(0, queryIndex) : pathAndQuery;
  const rawQuery = queryIndex >= 0 ? pathAndQuery.slice(queryIndex + 1) : "";

  let pathname = rawPathname || "/";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/+/g, "/");
  pathname = pathname.replace(/^\/v\d+\.\d+(?=\/|$)/, "") || "/";
  if (pathname.length > 1) pathname = pathname.replace(/\/$/, "");

  return { pathname, queryParams: new URLSearchParams(rawQuery) };
}

function normalizeResourceType(type: string): string {
  const normalizedType = type.trim().toLowerCase();
  switch (normalizedType) {
    case "business":
    case "business_id":
      return "businesses";
    case "ad_account":
    case "account":
    case "account_id":
    case "ad_account_id":
      return "ad_accounts";
    case "page":
    case "page_id":
      return "pages";
    case "instagram_account":
    case "instagram_business_account":
    case "ig_account":
      return "instagram_accounts";
    case "pixel":
    case "adspixel":
      return "pixels";
    case "product_catalog":
    case "catalog":
      return "product_catalogs";
    case "system_user":
      return "system_users";
    default:
      return normalizedType;
  }
}

function normalizeResourceId(id: string): string {
  const trimmedId = id.trim();
  return /^act_\d+$/.test(trimmedId) ? trimmedId.slice(4) : trimmedId;
}

function splitIdValues(value: string): string[] {
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function valueToIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => valueToIds(entry));
  if (typeof value === "number" || typeof value === "bigint") return [String(value)];
  if (typeof value !== "string") return [];
  return splitIdValues(value);
}

function inferQueryType(key: string): string | undefined {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "ids" || normalizedKey === "id") return "unknown";
  if (!normalizedKey.endsWith("_id")) return undefined;
  if (normalizedKey === "business_id" || normalizedKey.endsWith("business_id")) return "business";
  if (normalizedKey === "account_id" || normalizedKey.endsWith("ad_account_id")) return "ad_account";
  if (normalizedKey === "page_id" || normalizedKey.endsWith("page_id")) return "page";
  if (
    normalizedKey === "instagram_business_account_id" ||
    normalizedKey.endsWith("instagram_account_id") ||
    normalizedKey.endsWith("ig_account_id")
  ) {
    return "instagram_account";
  }
  if (normalizedKey.endsWith("pixel_id")) return "pixel";
  if (normalizedKey.endsWith("catalog_id")) return "product_catalog";
  if (normalizedKey.endsWith("system_user_id")) return "system_user";
  return "unknown";
}

function inferPathType(segments: string[], idIndex: number): string {
  const previous = segments[idIndex - 1]?.toLowerCase();
  const next = segments[idIndex + 1]?.toLowerCase();

  if (next === "insights") return "unknown";
  if (
    next === "campaigns" ||
    next === "adsets" ||
    next === "ads" ||
    next === "adcreatives" ||
    next === "customaudiences" ||
    next === "adspixels"
  ) {
    return "ad_account";
  }
  if (next === "feed" || next === "posts" || next === "photos" || next === "videos") {
    return "page";
  }
  if (next === "media" || next === "stories") return "instagram_account";
  if (next === "products" || next === "product_sets") return "product_catalog";
  if (
    next === "owned_ad_accounts" ||
    next === "client_ad_accounts" ||
    next === "owned_pages" ||
    next === "client_pages" ||
    next === "owned_instagram_accounts" ||
    next === "owned_pixels" ||
    next === "owned_product_catalogs" ||
    next === "client_product_catalogs" ||
    next === "system_users"
  ) {
    return "business";
  }

  if (previous === "adaccounts" || previous === "owned_ad_accounts" || previous === "client_ad_accounts") {
    return "ad_account";
  }
  if (previous === "accounts" || previous === "pages" || previous === "owned_pages" || previous === "client_pages") {
    return "page";
  }
  if (previous === "owned_instagram_accounts" || previous === "instagram_accounts") {
    return "instagram_account";
  }
  if (previous === "adspixels" || previous === "owned_pixels" || previous === "pixels") return "pixel";
  if (
    previous === "owned_product_catalogs" ||
    previous === "client_product_catalogs" ||
    previous === "product_catalogs" ||
    previous === "catalogs"
  ) {
    return "product_catalog";
  }
  if (previous === "system_users") return "system_user";

  return "unknown";
}

function isMetaId(value: string): boolean {
  return /^(?:act_)?\d+$/.test(value);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getErrorStatus(error: unknown): number | undefined {
  const candidate = error as { response?: { status?: unknown }; status?: unknown };
  if (typeof candidate.response?.status === "number") return candidate.response.status;
  if (typeof candidate.status === "number") return candidate.status;
  return undefined;
}

function describeError(error: unknown): string {
  const status = getErrorStatus(error);
  if (status !== undefined) return `HTTP ${status}`;
  if (error instanceof Error && error.message) return error.message;
  return "unknown error";
}

import { AxiosError } from "axios";
import { z } from "zod";
import { CHARACTER_LIMIT } from "../constants.js";
import { BusinessAuthorizationError } from "./business-authorization.js";

// Shared Zod schema for response_format parameter — used by all tools
export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

// Shared annotation presets
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const MUTATING_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

type McpErrorResult = {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  structuredContent?: { code: string; message: string };
};

type McpTextResult = {
  content: Array<{ type: "text"; text: string }>;
};

type DataEnvelope<T> = {
  data?: T[];
  paging?: unknown;
};

type MetaErrorDetails = {
  code?: number;
  error_subcode?: number;
  message?: string;
  type?: string;
};

const META_DEV_RATE_LIMIT_CODE = 80004;
const META_DEV_RATE_LIMIT_SUBCODE = 2446079;
const META_APP_RATE_LIMIT_CODE = 4;
const META_APP_RATE_LIMIT_MESSAGE = "application request limit reached";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function numericMetaField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  return undefined;
}

function findMetaError(value: unknown, seen = new Set<unknown>()): MetaErrorDetails | null {
  if (!isRecord(value) || seen.has(value)) {
    return null;
  }
  seen.add(value);

  const code = numericMetaField(value.code ?? value.error_code);
  const errorSubcode = numericMetaField(value.error_subcode ?? value.errorSubcode ?? value.subcode);

  if (code !== undefined || errorSubcode !== undefined) {
    return {
      code,
      error_subcode: errorSubcode,
      message: typeof value.message === "string" ? value.message : undefined,
      type: typeof value.type === "string" ? value.type : undefined,
    };
  }

  for (const child of Object.values(value)) {
    const found = findMetaError(child, seen);
    if (found) {
      return found;
    }
  }

  return null;
}

function resultText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return "";
  }

  return value.content
    .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
    .join("\n");
}

function parseMetaErrorFromText(text: string | undefined): MetaErrorDetails | null {
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const found = findMetaError(parsed);
    if (found) {
      return found;
    }
  } catch {
    // Human-readable MCP errors fall through to the regex parser.
  }

  const pairMatch = text.match(/\b(\d+)\/(\d+)\b/);
  if (pairMatch) {
    return {
      code: Number.parseInt(pairMatch[1], 10),
      error_subcode: Number.parseInt(pairMatch[2], 10),
      message: text,
    };
  }

  const humanErrorCodeMatch = text.match(/\bError\s*\((\d+)\)/i) ?? text.match(/\(#(\d+)\)/);
  if (humanErrorCodeMatch) {
    return {
      code: Number.parseInt(humanErrorCodeMatch[1], 10),
      message: text,
    };
  }

  const codeMatch = text.match(/"?code"?\s*[:=]\s*(\d+)/i);
  const subcodeMatch = text.match(/"?error_subcode"?\s*[:=]\s*(\d+)/i);
  if (codeMatch || subcodeMatch) {
    return {
      code: codeMatch ? Number.parseInt(codeMatch[1], 10) : undefined,
      error_subcode: subcodeMatch ? Number.parseInt(subcodeMatch[1], 10) : undefined,
      message: text,
    };
  }

  return null;
}

function extractMetaError(value: unknown): MetaErrorDetails | null {
  const structured =
    findMetaError(isRecord(value) ? value.metaError : undefined) ??
    findMetaError(isRecord(value) ? value.mcpResult : undefined) ??
    findMetaError(value);
  if (structured) {
    return structured;
  }

  if (!isRecord(value)) {
    return null;
  }

  const mcpResultText = resultText(value.mcpResult);
  const parsedMcpResult = parseMetaErrorFromText(mcpResultText);
  if (parsedMcpResult) {
    return parsedMcpResult;
  }

  if (typeof value.message === "string") {
    const parsedMessage = parseMetaErrorFromText(value.message);
    if (parsedMessage) {
      return parsedMessage;
    }
  }

  const contentText = resultText(value);
  return parseMetaErrorFromText(contentText);
}

export function isMetaDevRateLimit(error: unknown): boolean {
  const metaError = extractMetaError(error);
  if (!metaError) return false;

  if (
    metaError.code === META_DEV_RATE_LIMIT_CODE &&
    metaError.error_subcode === META_DEV_RATE_LIMIT_SUBCODE
  ) {
    return true;
  }

  return (
    metaError.code === META_APP_RATE_LIMIT_CODE &&
    typeof metaError.message === "string" &&
    metaError.message.toLowerCase().includes(META_APP_RATE_LIMIT_MESSAGE)
  );
}

export function errorResult(error: unknown): McpErrorResult {
  const message = handleApiError(error);
  if (error instanceof BusinessAuthorizationError) {
    return {
      content: [{ type: "text" as const, text: message }],
      structuredContent: { code: "BUSINESS_AUTH_DENIED", message: error.message },
      isError: true,
    };
  }

  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function jsonResult(value: unknown): McpTextResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function jsonDataResult<T>(response: DataEnvelope<T>, data: T[] = response.data ?? []): McpTextResult {
  return jsonResult({ ...response, data });
}

export function handleApiError(error: unknown): string {
  if (error instanceof BusinessAuthorizationError) {
    return `Error [BUSINESS_AUTH_DENIED]: ${error.message}`;
  }

  if (error instanceof AxiosError) {
    if (error.response) {
      const data = error.response.data as Record<string, unknown> | undefined;
      const metaError = data?.error as Record<string, unknown> | undefined;
      if (metaError) {
        const code = metaError.code;
        const msg = metaError.message ?? metaError.error_user_msg;
        const msgText = typeof msg === "string" ? msg : String(msg ?? "Unknown error");
        const subcode = metaError.error_subcode;

        // Provide actionable guidance for common error codes
        if (code === 190) {
          return (
            `Error: Access token is invalid or expired (${code}${subcode ? `/${subcode}` : ""}).\n\n` +
            `To fix: Generate a new long-lived token at https://developers.facebook.com/tools/explorer/ ` +
            `and update META_ACCESS_TOKEN in your MCP config.`
          );
        }
        if (code === 10 || code === 200) {
          return (
            `Error: Missing permission or app-review gated access (${code}${subcode ? `/${subcode}` : ""}): ${msgText}\n\n` +
            `Grant the required permission at https://developers.facebook.com/tools/explorer/ and regenerate your token. ` +
            `For public content, Page tabs, Instagram messaging, and Ad Library endpoints, the app must also have the relevant Meta App Review feature approved; a new token alone will not unlock those endpoints.`
          );
        }

        return `Error (${code}${subcode ? `/${subcode}` : ""}): ${msgText}`;
      }
      switch (error.response.status) {
        case 400:
          return "Error: Bad request — check your parameters.";
        case 401:
          return "Error: Unauthorized — your access token is invalid or expired. Regenerate at https://developers.facebook.com/tools/explorer/";
        case 403:
          return "Error: Permission denied — your token lacks the required permissions. Grant them at https://developers.facebook.com/tools/explorer/";
        case 404:
          return "Error: Resource not found — check the ID is correct.";
        case 429:
          return "Error: Rate limit exceeded — wait before making more requests. See Meta rate limiting docs.";
        default:
          return `Error: API request failed with status ${error.response.status}.`;
      }
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request timed out — try again or break the query into smaller requests.";
    } else if (error.code === "ENOTFOUND") {
      return "Error: Cannot reach graph.facebook.com — check your internet connection.";
    }
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: Unexpected error occurred.`;
}

export function truncateField(text: string | undefined, limit = 200): string {
  if (!text) return "";
  return text.length > limit ? text.slice(0, limit) + "..." : text;
}

export function truncate(text: string, label = "items"): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const truncated = text.slice(0, CHARACTER_LIMIT);
  return (
    truncated +
    `\n\n[Response truncated at ${CHARACTER_LIMIT} characters. Use pagination (after cursor) or filters to get more ${label}.]`
  );
}

export function formatCurrency(amount: string | undefined, currency = "USD"): string {
  if (!amount) return "N/A";
  // Meta returns amounts in cents
  const dollars = (parseInt(amount, 10) / 100).toFixed(2);
  return `${dollars} ${currency}`;
}

export function formatBudget(
  daily?: string,
  lifetime?: string,
  currency = "USD"
): string {
  if (daily) return `${formatCurrency(daily, currency)}/day`;
  if (lifetime) return `${formatCurrency(lifetime, currency)} lifetime`;
  return "N/A";
}

export function formatDate(isoString?: string): string {
  if (!isoString) return "N/A";
  return new Date(isoString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatNumber(n: string | number | undefined): string {
  if (n === undefined || n === null) return "N/A";
  const num = Number(n);
  if (isNaN(num)) return String(n);
  return num.toLocaleString();
}

export function buildPaginationNote(
  count: number,
  afterCursor?: string
): string {
  if (!afterCursor) return "";
  return `\n\n_Showing ${count} results. Pass \`after="${afterCursor}"\` to get the next page._`;
}

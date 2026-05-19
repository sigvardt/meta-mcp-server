# Worklog

## 2026-05-19 — v2.0.3: Bug-fix sweep (issue #1) + business-id allowlist hardening

### Hardening: built-in rate-limit retry + pacing

Meta rate limiting (`80004/2446079` dev-tier limits and `code:4` app-level request limits) now lives in `MetaApiClient`, not just the live-acid harness. Every Graph call through the client is paced with `META_RATE_LIMIT_PACE_MS` (default `5000`, `0` disables) and retried with `META_RATE_LIMIT_RETRIES` (default `3`, `0` disables) using 30s, 60s, and 120s backoff. `scripts/live-acid-test.mjs` now just calls MCP tools and keeps its per-call pass/fail reporting; duplicate retry and sleep logic was removed.

**What changed**: Comprehensive sweep of 20 documented Meta-API bugs from [issue #1](https://github.com/oliverames/meta-mcp-server/issues/1) plus a major security hardening: the new `BusinessAuthorizationService` (src/services/business-authorization.ts) now gates every Graph API call against an allowlist seeded from `META_ALLOWED_BUSINESS_IDS` (defaults to Dynamic Retail ApS `833812607571849`). Bootstrap fetches owned/client ad accounts, pages, Instagram accounts, pixels, product catalogs, and system users at startup; subsequent calls are checked path-by-path with a curated `BYPASS_PATHS` allowlist for non-business-scoped routes (e.g. `/me`, `/debug_token`). Bug fixes: rebuilt metric defaults for `meta_get_page_insights`, `meta_get_post_insights`, `meta_get_page_fan_demographics` (removed deprecated metrics like `page_impressions`, `page_engaged_users`, `unique_impressions`); added `metric_type` pass-through to `meta_get_instagram_account_insights`; made `thumbnails` opt-in for `meta_get_page_videos`; reworked `meta_get_promotable_posts` to use `/feed?is_eligible_for_promotion=true`; reworked `meta_get_page_automated_responses` to use `/me/messenger_profile` with PAGE token; fixed `meta_get_pixel_stats` aggregation enum (16 documented values); narrowed `meta_search_instagram_hashtag` hashtag-lookup fields; trimmed `meta_get_instagram_media_children` default fields; fixed `meta_list_offline_event_sets` endpoint; dropped `approximate_count` from `meta_list_saved_audiences`; added `IG_BROADCAST_CHANNELS_DEPRECATED` stub for `meta_get_instagram_broadcast_channels`; deleted `meta_get_pixel_events` (redundant with `meta_get_pixel_stats({aggregation:"event"})`) and `meta_search_places` (Meta retired Place Search for 3rd parties in v8.0). Added narrow 190/2069032 page-token auto-refresh (single retry, cached page tokens only). Added live-acid test harness (`scripts/live-acid-test.mjs` + `scripts/cleanup-orphans.mjs`) gated on `RUN_LIVE_ACID=1` with journal-based orphan-post recovery. Tool count: 200 → 198.

**Decisions made**:
- **Fork-only, no upstream PR**: This sweep is for our own fork. Upstreaming is out of scope.
- **Allowlist default**: `833812607571849` (Dynamic Retail ApS / Shameless.dk). Override via `META_ALLOWED_BUSINESS_IDS` (comma-separated business IDs).
- **Fail-closed bootstrap**: Default behaviour rejects unknown paths. `META_AUTH_BOOTSTRAP_MODE=warn` flips to log-and-allow for dev/diagnostic use.
- **5s freshness threshold** on cached page tokens for 190/2069032 auto-refresh — avoids hammering refresh on every call.
- **Journal-style live-acid cleanup**: Append intended deletes to `.sisyphus/orphaned-posts.log` (gitignored) BEFORE the destructive call; scrub on success; `scripts/cleanup-orphans.mjs` retries at startup.
- **DELETE over repoint** for `meta_search_places` (retired) and `meta_get_pixel_events` (redundant). Both documented in `.sisyphus/evidence/`.
- **DEPRECATE-STUB** for `meta_get_instagram_broadcast_channels` (kept registration; returns structured `IG_BROADCAST_CHANNELS_DEPRECATED` error).

**Left off at**: All 22 implementation tasks (T1-T22) verified, build clean, 107 tests + 1 skipped pass across 21 test files. Live-acid suite (T23/T24) requires a real `META_ACCESS_TOKEN` to execute against Dynamic Retail — operator must run `RUN_LIVE_ACID=1 npm run test:live` once credentials are in place. Final Verification Wave (F1-F4) still pending.

**Open questions**: Should we eventually upstream the business-id allowlist to oliverames/meta-mcp-server as an opt-in security feature? Threads token-gap issues from the original 20-bug list remain out of scope for this sweep. Concurrent-bootstrap race condition has one `it.skip` test in `src/__tests__/business-authorization.test.ts` — documented in `.sisyphus/notepads/meta-mcp-bugfix-and-test-hardening/issues.md`.

---



## 2026-04-06 — 1Password CLI fallback for credential resolution

**What changed**: Added automatic 1Password CLI fallback to credential resolution at startup. When environment variables are not set, the server attempts to resolve them via `op read` from the Development vault before failing. Uses `execFileSync` (Node) or `exec.Command` (Go) for shell-safe execution with a 10s timeout. Silent no-op if 1Password CLI is unavailable. Updated README to document the integration with `op://` reference paths. Part of a broader session that also touched ynab-mcp-server, imagerelay-mcp-server, meta-mcp-server, sprout-mcp-server, and ames-unifi-mcp.

**Decisions made**: Used `execFileSync` instead of `execSync` to avoid shell injection surface (even though inputs are hardcoded string literals). Added the fallback as a separate `op-fallback.ts` module (TS servers) or inline helper (Go) rather than modifying the existing auth flow, keeping the env var path as primary (zero overhead) and 1Password as fallback only. Chose `op://Development/` vault paths matching existing 1Password item names where items exist; for servers without items yet (Meta, Sprout, UniFi), chose conventional names so items can be created later.

**Left off at**: Published and pushed. 1Password items still need to be created for Meta Access Token, Threads Access Token, Sprout API Token/OAuth Client, and UniFi Controller credentials. YNAB and ImageRelay items already exist. Also: 20 uncategorized YNAB transactions from this session's review were identified but not yet categorized.

**Open questions**: None.

---



## 2026-03-22 — v2.1.0: 18 bug fixes, 13 new tools (187 → 200), CAPI schema expansion

**What changed**: Comprehensive 10-iteration review of the entire MCP server codebase. Fixed 18 bugs (6 critical duplicate tool registrations that crashed the server, wrong API endpoints for Threads search and Instagram comment replies, double-stringified DM payloads, incorrect Facebook Reels upload flow, overly restrictive CAPI event enum). Added 13 new tools covering lead gen forms, offline conversions, minimum budgets, Threads followers/following, product feeds, Instagram shopping catalogs, and Facebook Places search. Expanded CAPI UserDataSchema from 7 to 19 fields and CustomDataSchema from 7 to 13 fields. Updated all documentation references from 187 to 200 tools. Fixed integration test EPIPE race condition. Updated GitHub repo description and topics.

**Decisions made**:
- Changed CAPI `event_name` from a restrictive 7-item enum to `z.string()` — the Meta API accepts any string including custom events, so the enum was incorrectly blocking valid usage.
- Kept annotation objects inline rather than adopting the `READ_ONLY_ANNOTATIONS` presets from utils.ts — the presets aren't used anywhere in the existing 187 tools, so adopting them for just 13 new tools would create inconsistency. Better as a separate cleanup PR.
- Didn't extract a shared helper for threads_get_followers/following — at ~30 lines each, the duplication is small enough that a helper would add more complexity than it removes.
- Left Graph API version at v21.0 — changing it could break things without testing against actual API responses.

**Left off at**: The server is feature-complete at 200 tools. Next steps would be: (1) bump version to 2.1.0 in package.json and publish to npm, (2) consider adding WhatsApp Business Platform tools (biggest remaining API gap per research), (3) the annotation preset adoption could be done as a bulk refactor across all 200 tools.

**Open questions**:
- Should Graph API version be bumped to v22.0 or v23.0? Would need to test for any breaking changes in field names or response formats.
- WhatsApp Business Platform has zero coverage — is this in scope for this server or a separate project?
- The `meta_search_places` endpoint (`/search?type=place`) may be deprecated in newer API versions — monitor for replacement.

---

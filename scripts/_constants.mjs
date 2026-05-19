// Shared constants for live-acid testing.
// Single source of truth for safety-critical values.

export const ACID_TEST_POST_TEXT =
  "meta-mcp-server acid test — Hey there, how's it going? (auto-delete)";

export const DEFAULT_BUSINESS_ID = "833812607571849";

export const ORPHAN_LOG_PATH = ".sisyphus/orphaned-posts.log";

export const READ_ONLY_TOOLS = [
  "meta_get_account_insights",
  "meta_get_campaign_insights",
  "meta_get_adset_insights",
  "meta_get_ad_insights",
  "meta_get_page_insights",
  "meta_get_post_insights",
  "meta_get_page_fan_demographics",
  "meta_get_instagram_account_insights",
  "meta_get_page_videos",
  "meta_list_offline_event_sets",
  "meta_list_saved_audiences",
  "meta_get_promotable_posts",
  "meta_get_page_automated_responses",
  "meta_get_instagram_broadcast_channels",
  "meta_search_instagram_hashtag",
  "meta_get_instagram_media_children",
  "meta_get_pixel_stats",
];

export const WRITE_TOOLS = [
  "meta_create_post",
  "meta_delete_post",
];

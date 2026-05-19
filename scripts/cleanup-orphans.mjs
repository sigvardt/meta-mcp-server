#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ORPHAN_LOG_PATH } from "./_constants.mjs";
import { journalIsEmpty, readOrphans, scrubOrphan } from "./_orphan-journal.mjs";
import { callTool, startMcpServer, stopMcpServer } from "./_mcp-client.mjs";

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

function pageIdFor(orphan) {
  if (orphan.parentId) {
    return String(orphan.parentId);
  }

  if (orphan.pageId) {
    return String(orphan.pageId);
  }

  const postId = String(orphan.postId ?? "");
  const separatorIndex = postId.indexOf("_");

  return separatorIndex > 0 ? postId.slice(0, separatorIndex) : null;
}

function contentText(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function alertOperator({ postId, permalink, instruction }) {
  console.error("[cleanup-orphans] ORPHANED META POST REQUIRES MANUAL CLEANUP");
  console.error(`[cleanup-orphans] post_id: ${postId}`);
  console.error(`[cleanup-orphans] url: ${permalink ?? "unknown"}`);
  console.error(`[cleanup-orphans] instruction: ${instruction}`);
}

async function attemptDeleteOrphan(orphan) {
  const pageId = pageIdFor(orphan);

  if (!pageId) {
    return {
      ok: false,
      reason: "journal entry does not include a page ID and post ID is not page_id_post_id",
      instruction: `Open ${orphan.permalink ?? "the Meta post"}, delete it manually, then remove ${orphan.postId} from ${ORPHAN_LOG_PATH}.`,
    };
  }

  try {
    const result = await callTool("meta_delete_post", {
      post_id: String(orphan.postId),
      page_id: pageId,
    });

    if (result.isError) {
      return {
        ok: false,
        reason: contentText(result) || "meta_delete_post returned an error",
        instruction: `Open ${orphan.permalink ?? "the Meta post"}, delete it manually, then rerun cleanup.`,
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message ?? String(error),
      instruction: `Open ${orphan.permalink ?? "the Meta post"}, delete it manually, then rerun cleanup.`,
    };
  }
}

export async function cleanupOrphans() {
  if (journalIsEmpty()) {
    console.error("[cleanup-orphans] no orphans found");
    return 0;
  }

  const orphans = readOrphans();
  let deleted = 0;
  let failed = 0;

  try {
    await startMcpServer();

    for (const orphan of orphans) {
      const result = await attemptDeleteOrphan(orphan);

      if (result.ok) {
        deleted += 1;
        scrubOrphan(orphan.postId);
        console.error(`[cleanup-orphans] deleted orphan ${orphan.postId}`);
        continue;
      }

      failed += 1;
      alertOperator({
        postId: orphan.postId,
        permalink: orphan.permalink,
        instruction: result.instruction,
      });
      console.error(`[cleanup-orphans] delete failed for ${orphan.postId}: ${result.reason}`);
    }
  } finally {
    await stopMcpServer();
  }

  console.error(`[cleanup-orphans] ${deleted} deleted / ${failed} remaining`);
  return failed > 0 ? 1 : 0;
}

if (isMainModule()) {
  cleanupOrphans()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error("[cleanup-orphans] fatal error");
      console.error(error?.stack ?? String(error));
      process.exitCode = 1;
    });
}

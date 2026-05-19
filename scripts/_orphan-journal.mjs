import fs from "node:fs";
import path from "node:path";
import { ORPHAN_LOG_PATH } from "./_constants.mjs";

const journalPath = path.resolve(process.cwd(), ORPHAN_LOG_PATH);

function readJournalRows() {
  if (!fs.existsSync(journalPath)) {
    return [];
  }

  return fs
    .readFileSync(journalPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return { line, entry: JSON.parse(line) };
      } catch {
        return { line, entry: null };
      }
    });
}

function writeJournalRows(rows) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });

  const contents = rows
    .map((row) => (row.entry ? JSON.stringify(row.entry) : row.line))
    .join("\n");
  const tempPath = `${journalPath}.tmp`;

  fs.writeFileSync(tempPath, contents.length > 0 ? `${contents}\n` : "", "utf8");
  fs.renameSync(tempPath, journalPath);
}

export function appendOrphan(postId, type = "post", details = {}) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });

  const entry = {
    ...details,
    postId: String(postId),
    type: String(type),
    ts: details.ts ?? new Date().toISOString(),
  };

  fs.appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function scrubOrphan(postId) {
  const rows = readJournalRows();

  if (rows.length === 0) {
    return 0;
  }

  let removed = 0;
  const keptRows = rows.filter((row) => {
    if (row.entry?.postId === String(postId)) {
      removed += 1;
      return false;
    }

    return true;
  });

  writeJournalRows(keptRows);
  return removed;
}

export function readOrphans() {
  return readJournalRows()
    .map((row) => row.entry)
    .filter(Boolean);
}

export function journalIsEmpty() {
  return readOrphans().length === 0;
}

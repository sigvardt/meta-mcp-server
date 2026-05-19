import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");

let client = null;
let transport = null;
let startPromise = null;

export async function startMcpServer() {
  if (client) {
    return client;
  }

  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      cwd: repoRoot,
      env: { ...process.env },
      stderr: "inherit",
    });

    client = new Client({
      name: "meta-mcp-live-acid",
      version: "1.0.0",
    });

    await client.connect(transport);
    return client;
  })();

  try {
    return await startPromise;
  } catch (error) {
    client = null;
    transport = null;
    startPromise = null;
    throw error;
  }
}

export async function stopMcpServer() {
  const currentClient = client;

  client = null;
  transport = null;
  startPromise = null;

  if (currentClient) {
    await currentClient.close();
  }
}

export async function callTool(toolName, args = {}) {
  const mcpClient = await startMcpServer();
  return mcpClient.callTool({ name: toolName, arguments: args });
}

export async function listTools() {
  const mcpClient = await startMcpServer();
  return mcpClient.listTools();
}

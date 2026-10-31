#!/usr/bin/env node
// Cloak's MCP server over stdio: `npx @cloakely/mcp`. Configuration is environment variables only (see README).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCloakServer, loadSettings, VERSION } from "./server.js";
import { withLiveDeployment } from "./config.js";

try {
  const settings = await withLiveDeployment(loadSettings());
  const server = createCloakServer(settings);
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol, so anything for humans goes to stderr
  console.error(`cloak-mcp ${VERSION} on ${settings.network} (chain ${settings.chain.id}), ${settings.privateKey ? "wallet configured" : "read only"}${settings.dryRun ? ", dry run" : ""}`);
} catch (e) {
  console.error(`cloak-mcp: ${(e as Error).message}`);
  process.exit(1);
}

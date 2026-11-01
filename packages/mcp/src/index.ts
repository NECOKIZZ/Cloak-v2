#!/usr/bin/env node
// Cloak's MCP server over stdio: `npx @cloakely/mcp`. Configuration is environment variables (see README).
// `npx @cloakely/mcp setup` makes the agent's wallet in ~/.cloak-agent-key, which the server then uses by default.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCloakServer, loadSettings, VERSION } from "./server.js";
import { withLiveDeployment } from "./config.js";
import { setup } from "./setup.js";

if (process.argv[2] === "setup") {
  // make the agent's wallet and print what's left to do (see https://cloak.boblabs.tech/agent.md)
  await setup().then(
    () => process.exit(0),
    (e) => {
      console.error(`cloak-mcp setup: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}

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

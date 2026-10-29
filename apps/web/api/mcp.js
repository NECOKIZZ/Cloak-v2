// Cloak's hosted MCP server: https://cloak.boblabs.tech/mcp (a rewrite in vercel.json points it here).
// Read and plan only: it never has a key and never signs. See packages/mcp/src/http.ts.
import { handleMcpRequest } from "@cloakely/mcp/http";

export const config = { maxDuration: 30 };

export const GET = (req) => handleMcpRequest(req);
export const POST = (req) => handleMcpRequest(req);
export const DELETE = (req) => handleMcpRequest(req);
export const OPTIONS = (req) => handleMcpRequest(req);

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadSettings, type Settings } from "./config.js";
import { createCloakServer } from "./server.js";

/**
 * The hosted MCP endpoint as a web-standard handler (Request in, Response out), for any serverless runtime.
 * Streamable HTTP, stateless: every POST gets a fresh read-and-plan server, the answer is plain JSON, and nothing is
 * kept. With no sessions, GET (an event stream) and DELETE (ending a session) answer 405, as the spec allows; a
 * browser opening the URL is sent to the setup docs instead.
 */
const REQUESTS_PER_MINUTE = 60;
const MAX_BODY_BYTES = 64_000;
const DOCS = "https://cloak.boblabs.tech/docs#agents";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version, Retry-After",
  "Access-Control-Max-Age": "86400",
};

function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...CORS, "Cache-Control": "no-store", ...extra })) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const rpcError = (status: number, code: number, message: string, extra?: Record<string, string>) =>
  withHeaders(Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status }), extra);

// Best effort, per instance: a serverless platform may run several, so this caps bursts rather than guaranteeing a rate.
const hits = new Map<string, { start: number; n: number }>();
function limited(ip: string): number {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > 60_000) {
    if (hits.size > 10_000) hits.clear();
    hits.set(ip, { start: now, n: 1 });
    return 0;
  }
  h.n++;
  return h.n > REQUESTS_PER_MINUTE ? Math.ceil((h.start + 60_000 - now) / 1000) : 0;
}

let settings: Settings | undefined;

/** `settings` defaults to Elysium testnet, without a key (tests pass their own). */
export async function handleMcpRequest(req: Request, opts: { settings?: Settings } = {}): Promise<Response> {
  if (req.method === "OPTIONS") return withHeaders(new Response(null, { status: 204 }));
  if (req.method === "GET") {
    const accept = req.headers.get("accept") ?? "";
    if (accept.includes("text/html") && !accept.includes("text/event-stream")) return withHeaders(Response.redirect(DOCS, 307));
    return rpcError(405, -32000, "Method not allowed. This server is stateless: POST JSON-RPC messages to this URL.", { Allow: "POST, OPTIONS" });
  }
  if (req.method !== "POST") return rpcError(405, -32000, "Method not allowed. This server keeps no sessions.", { Allow: "POST, OPTIONS" });

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
  const wait = limited(ip);
  if (wait) return rpcError(429, -32000, `Too many requests. Try again in ${wait} seconds.`, { "Retry-After": String(wait) });
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return rpcError(413, -32600, "Request too large.");
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return rpcError(413, -32600, "Request too large.");
    body = JSON.parse(text);
  } catch {
    return rpcError(400, -32700, "Parse error: send a JSON-RPC message as JSON.");
  }

  // the body is already parsed, so be lenient about the headers: the answer is always JSON
  const headers = new Headers(req.headers);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const forward = new Request(req.url, { method: "POST", headers });

  // never a key here, whatever the environment says
  const s = opts.settings ?? (settings ??= loadSettings({ CLOAK_NETWORK: "testnet", CLOAK_RPC_URL: process.env.CLOAK_RPC_URL, CLOAK_RELAYER_URL: process.env.CLOAK_RELAYER_URL }));
  const server = createCloakServer(s, { hosted: true });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return withHeaders(await transport.handleRequest(forward, { parsedBody: body }));
  } catch (e) {
    console.error("cloak-mcp hosted:", (e as Error)?.name ?? "error");
    return rpcError(500, -32603, "Internal error.");
  } finally {
    await server.close().catch(() => {});
  }
}

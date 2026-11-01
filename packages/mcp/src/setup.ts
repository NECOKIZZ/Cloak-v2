// `npx -y @cloakely/mcp setup`: make the agent's own wallet (once) and say what's left to do, in words an agent can pass
// on to a person. Written for agents following https://cloak.boblabs.tech/agent.md. The key is never printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, formatEther, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { elysiumTestnet } from "@cloakely/sdk";
import { defaultKeyFile } from "./config.js";

const FAUCET = "https://elysium.kinetiq.xyz/testnet-faucet";

export async function setup(): Promise<void> {
  const file = process.env.CLOAK_KEY_FILE || defaultKeyFile();
  let made = false;
  if (!existsSync(file)) {
    // owner-only from the start; `wx` refuses to overwrite a file that appeared in between
    writeFileSync(file, `${generatePrivateKey()}\n`, { mode: 0o600, flag: "wx" });
    made = true;
  }
  let key = readFileSync(file, "utf8").trim();
  if (!key.startsWith("0x")) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${file} doesn't hold a private key. Move it aside and run setup again.`);
  const address = privateKeyToAccount(key as Hex).address;
  const pub = createPublicClient({ chain: elysiumTestnet, transport: http(undefined, { timeout: 15_000 }) });
  const balance = await pub.getBalance({ address }).catch(() => undefined);
  const funded = balance !== undefined && balance > 0n;
  const out = {
    status: made ? "Made a new wallet for the agent." : "The agent's wallet already exists. Kept it.",
    agentWallet: address,
    keyFile: `${file} (readable by this user only, never printed and never sent anywhere)`,
    network: "Elysium testnet (play money only)",
    balance: balance === undefined ? "couldn't read it right now" : `${formatEther(balance)} HYPE`,
    next: [
      "Add the Cloak MCP server to this app if it isn't there yet. Claude Code: claude mcp add cloak -- npx -y @cloakely/mcp. Any other app: an MCP server with command npx and args -y @cloakely/mcp. It uses this wallet without any settings.",
      funded
        ? "The wallet has HYPE, so it's ready."
        : `Ask the person to get free testnet HYPE for ${address} at ${FAUCET}. Copy the address for them exactly. Agents can't use the faucet themselves.`,
      "Tell the person to restart the app or start a new chat so the Cloak tools load, then call cloak_info to check.",
    ],
  };
  console.log(JSON.stringify(out, null, 2));
}

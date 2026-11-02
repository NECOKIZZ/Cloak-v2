import { useState } from "react";
import { Icon } from "../ui";

const ASK = "Read https://cloak.boblabs.tech/agent.md and set me up to trade privately.";

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn btn-ghost btn-sm"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Icon.check size={14} /> : <Icon.copy size={14} />}
      {done ? "Copied" : label}
    </button>
  );
}

function Cmd({ children }: { children: string }) {
  return (
    <div className="summary mono xs" style={{ display: "flex", alignItems: "center", gap: 10, wordBreak: "break-all" }}>
      <span style={{ flex: 1 }}>{children}</span>
      <Copy text={children} />
    </div>
  );
}

/** Cloak for AI agents: the one-line setup, the read-only link, and what the full agent can do. */
export function Agents() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <p>Let Claude, ChatGPT, Cursor or any AI agent launch, bid and trade privately on Cloak.</p>
        </div>
      </div>

      <div className="card wallet-hero">
        <div className="row-flex"><span className="soft">The easy way</span><span className="pill ok">One sentence</span></div>
        <p style={{ font: "300 26px/1.25 var(--font-display)", letterSpacing: "-0.02em", margin: "16px 0 10px" }}>Tell your agent</p>
        <Cmd>{ASK}</Cmd>
        <p className="small mute" style={{ margin: 0 }}>
          The page is written for the agent. It works out what it can do in your app, sets up its own wallet and the connection,
          and asks you only for what it can't do itself, like getting free testnet HYPE from the faucet. It never needs your own wallet's key.
        </p>
      </div>

      <div className="grid">
        <div className="col">
          <div className="card">
            <div className="card-head"><h3>Full agent</h3><span className="pill">launch, bid, trade</span></div>
            <p className="small mute">Runs on your own machine with a wallet made just for the agent. It signs there and makes its proofs there, so nobody else, Cloak included, can see or move the funds.</p>
            <div className="field"><label><span>1. Make the agent's wallet (the key is never printed)</span></label><Cmd>npx -y @cloakely/mcp setup</Cmd></div>
            <div className="field"><label><span>2. Fund the address it prints</span></label>
              <p className="small" style={{ margin: 0 }}>Get free testnet HYPE from the <a className="link" href="https://elysium.kinetiq.xyz/testnet-faucet" target="_blank" rel="noreferrer">Elysium faucet</a>.</p>
            </div>
            <div className="field"><label><span>3. Connect it. Claude Code</span></label><Cmd>claude mcp add cloak -- npx -y @cloakely/mcp</Cmd></div>
            <div className="field" style={{ marginBottom: 0 }}><label><span>Claude Desktop, Cursor and others</span></label><Cmd>{'{ "mcpServers": { "cloak": { "command": "npx", "args": ["-y", "@cloakely/mcp"] } } }'}</Cmd></div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Look around without a wallet</h3><span className="pill">read only</span></div>
            <p className="small mute">Paste this link into your AI app to browse launches, read them and price bids and swaps. It never signs and refuses anything that looks like a key.</p>
            <Cmd>https://cloak.boblabs.tech/mcp</Cmd>
            <ul className="small soft" style={{ paddingLeft: 18, margin: "4px 0 0", display: "grid", gap: 6 }}>
              <li><b>Claude</b> (claude.ai or Desktop): Settings, Connectors, Add custom connector, then paste the link.</li>
              <li><b>ChatGPT</b>: turn on developer mode under Apps and connectors, then add a connector with the link and no authentication.</li>
              <li><b>Claude Code</b>: <code>claude mcp add --transport http cloak https://cloak.boblabs.tech/mcp</code></li>
            </ul>
          </div>
        </div>
        <div className="col">
          <div className="card flat">
            <h3>Then just ask</h3>
            <ul className="small soft" style={{ paddingLeft: 18, margin: "10px 0 0", display: "grid", gap: 8 }}>
              <li>"Shield 0.5 HYPE, then buy CLOAK privately with 0.1 of it."</li>
              <li>"What Cloak launches are open right now?"</li>
              <li>"Bid on this launch up to 0.00002 HYPE for 50,000 tokens. Dry run first."</li>
              <li>"Send 0.05 private HYPE to cloak:…, then withdraw the rest to a fresh address."</li>
              <li>"Make a payment link with 0.02 HYPE, locked with a riddle about Elysium."</li>
            </ul>
          </div>
          <div className="card flat">
            <h3>Built-in safety</h3>
            <ul className="small soft" style={{ paddingLeft: 18, margin: "10px 0 0", display: "grid", gap: 6 }}>
              <li>It never asks for your own wallet's key.</li>
              <li>Spending limits per trade and per day (1 and 10 HYPE by default).</li>
              <li>A dry run for every action.</li>
              <li>Testnet by default. Mainnet needs two explicit settings.</li>
              <li>The agent's key never leaves your machine.</li>
            </ul>
            <p className="small" style={{ margin: "14px 0 0" }}>
              <a className="link" href="/agent.md" target="_blank" rel="noreferrer">agent.md</a> · <a className="link" href="https://www.npmjs.com/package/@cloakely/mcp" target="_blank" rel="noreferrer">@cloakely/mcp on npm</a>
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

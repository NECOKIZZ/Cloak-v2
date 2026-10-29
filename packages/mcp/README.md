# @cloakely/mcp

**Cloak's MCP server.** It lets an AI agent launch tokens with sealed bids and trade them privately on Kinetiq's Elysium, from Claude, Cursor or any MCP client.

An agent that trades on chain leaks its strategy with every transaction, and anyone can copy or front-run it. With Cloak, its bids stay sealed until bidding closes, and its trades come from a private balance: each one is proven on the agent's machine and sent by a relayer, so the agent's wallet never appears on them.

**Testnet only for now** (Elysium testnet, chain `99801`). Play money only.

## Set up

Create a fresh wallet for the agent, fund it from the [Elysium faucet](https://elysium.kinetiq.xyz/testnet-faucet), and put its private key in a file only you can read:

```sh
umask 077 && echo 0xYOUR_AGENT_KEY > ~/.cloak-agent-key
```

**Claude Code:**

```sh
claude mcp add cloak --env CLOAK_KEY_FILE=$HOME/.cloak-agent-key -- npx -y @cloakely/mcp
```

**Claude Desktop, Cursor and other clients** (`claude_desktop_config.json`, `.cursor/mcp.json`, and so on):

```json
{
  "mcpServers": {
    "cloak": {
      "command": "npx",
      "args": ["-y", "@cloakely/mcp"],
      "env": { "CLOAK_KEY_FILE": "/Users/you/.cloak-agent-key" }
    }
  }
}
```

Without a key, the server is **read only**: the agent can browse launches and quote bids and swaps, but can't sign anything.

Then ask, for example:
- "What Cloak launches are open right now?"
- "Launch a token called Ember, 1M for sale, starting at 0.000001 HYPE, bidding open for an hour."
- "Bid on EMBR up to 0.00002 HYPE for 50,000 tokens. Dry run first."
- "Shield 0.5 HYPE, then buy CLOAK privately with 0.1 of it."
- "Send 0.05 private HYPE to cloak:…, then withdraw the rest to 0x…"

## Tools

| Group | Tool | What it does |
|---|---|---|
| Read | `cloak_info` | Network, contracts, the wallet and its public balances, spending limits with what's left today |
| | `list_launches` | Launches, newest first, with phase, timing, prices and whether private trading is on |
| | `get_launch` | One launch in full: timing, prices, caps, results, revealed demand once bids open |
| | `quote_bid` | The price tick, cost and rounded deposit for a bid |
| | `quote_swap` | Expected output of a private buy or sell, with the fees |
| Launch | `create_launch` | Start a sealed-bid launch |
| | `place_sealed_bid` | Commit a sealed bid. It opens by itself after bidding closes |
| | `my_bids` | The wallet's bids: opened, claimed, tokens won, refund |
| | `claim` | Settle if nobody has, then claim tokens and refunds |
| | `enable_private_trading` | Open a private vault for a settled launch's token |
| Private | `unlock` | Derive the private account from one local signature and return its `cloak:` address |
| | `private_balance` | HYPE, USDC and launch tokens held privately |
| | `shield` | HYPE or USDC from the wallet into the private balance (the one public step) |
| | `private_swap` | Buy or sell a launch token from the private balance |
| | `batch_order` | Trade in standard sizes inside a batch round, which hides the trade's size |
| | `private_send` | Pay a `cloak:` address. Sender, recipient and amount stay hidden |
| | `withdraw` | Private balance to a normal address (ideally a fresh one) |

Amounts are in whole units (`"0.5"` HYPE). `private_send`, `withdraw` and a `private_swap` sell accept `"max"`.

## Safety

- **Spending limits.** Every action that moves value is checked first: bids, shields, swaps (either side, valued in HYPE at the pool price), batch orders, sends and withdrawals. There's a cap per transaction and per UTC day for HYPE value, a separate one for USDC, and a number of launches per day. The day's totals are kept in `~/.cloak-mcp`, so restarting the server doesn't reset them.
- **Dry run.** Every write tool takes `dry_run: true` and returns exactly what it would do, without signing or sending anything. `CLOAK_DRY_RUN=1` makes every write a dry run.
- **Testnet by default.** Mainnet needs `CLOAK_NETWORK=mainnet` and `CLOAK_ALLOW_MAINNET=1`, and isn't live yet.
- **The key stays on your machine.** It signs locally and is never sent anywhere. The private account is derived from a local signature, and proofs are generated locally (the circuit files are downloaded once and checked against the hashes pinned in `@cloakely/sdk`). The relayer only sees proofs, which it can submit but can't change.
- **One write at a time**, so two calls never spend the same private notes.
- Give the agent a **dedicated wallet** with only what you're willing to let it spend.

## Configuration

| Variable | Default | |
|---|---|---|
| `CLOAK_KEY_FILE` | | File holding the agent wallet's private key (preferred) |
| `CLOAK_PRIVATE_KEY` | | The key itself, if a file isn't practical |
| `CLOAK_NETWORK` | `testnet` | `testnet`, or `custom` with `CLOAK_DEPLOYMENT_FILE` |
| `CLOAK_MAX_HYPE_PER_TX` | `1` | HYPE value per transaction |
| `CLOAK_MAX_HYPE_PER_DAY` | `10` | HYPE value per UTC day |
| `CLOAK_MAX_USDC_PER_TX` | `100` | USDC per transaction |
| `CLOAK_MAX_USDC_PER_DAY` | `1000` | USDC per UTC day |
| `CLOAK_MAX_LAUNCHES_PER_DAY` | `3` | Launches per UTC day |
| `CLOAK_DRY_RUN` | | `1` turns every write into a dry run |
| `CLOAK_STATE_DIR` | `~/.cloak-mcp` | Daily spend totals and bid receipts |
| `CLOAK_RPC_URL` | Elysium testnet RPC | |
| `CLOAK_RELAYER_URL` | Cloak's hosted relayer | |
| `CLOAK_CIRCUITS_DIR` | download | Folder with `transaction2x2.wasm` and `transaction2x2_final.zkey` |

Built on [`@cloakely/sdk`](https://www.npmjs.com/package/@cloakely/sdk). Source: [NECOKIZZ/Cloak](https://github.com/NECOKIZZ/Cloak/tree/main/packages/mcp). MIT.

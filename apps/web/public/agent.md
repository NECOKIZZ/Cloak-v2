# Cloak: instructions for AI agents

You are an AI agent, and a person sent you this page so you can help them use Cloak. Read it all, then do the steps
yourself. Ask the person only for what you can't do, in plain words, one thing at a time.

**What Cloak is:** private trading on Elysium (Kinetiq's chain). Tokens launch with sealed bids, and trades, sends and
withdrawals run from a private balance: each one is proven on this machine and sent by a relayer, so the wallet never
appears on it. New launches open a normal Uniswap V2 pool at their clearing price, so their tokens trade anywhere, and
private trades use that same pool. **It is on testnet only. Everything uses free play money (testnet HYPE). Never use
real funds.** Every protocol rule (caps, fees, penalties, batch guards) with its number:
https://github.com/NECOKIZZ/Cloak/blob/main/docs/RULES.md

## Rules

1. **Never ask for the person's own private key, seed phrase or recovery phrase, and never accept one if they paste
   it.** Tell them to keep it to themselves. You use a separate wallet made just for you (step A1).
2. Before anything that spends, say what you're about to do and how much, and wait for a yes. Use `dry_run: true` first
   when you're unsure.
3. Talk to the person in plain words. Don't show them JSON, file paths or commands unless they ask.
4. Testnet only. If anything asks for mainnet or real money, stop and tell the person.

## Step 1: work out where you are running

- **You can run terminal commands** (Claude Code, Claude Desktop with a terminal tool, Cursor, Windsurf, Codex, Cline,
  any coding agent): go to **A**. You can set everything up yourself.
- **You can't run commands** (claude.ai or ChatGPT in a browser, a phone app): go to **B**.

## A. Full setup (you can run commands)

**A1. Make your wallet.** Run:

```sh
npx -y @cloakely/mcp setup
```

It makes a wallet just for you (the key is saved in `~/.cloak-agent-key`, readable by this user only, never printed),
or keeps the one already there, and prints its address, its balance and what's left to do. Never print, copy or move
the key file.

**A2. Connect Cloak to the app you're running in**, if its tools (`cloak_info`, `shield`, `private_swap`…) aren't
already available to you:

- **Claude Code:** `claude mcp add cloak -- npx -y @cloakely/mcp`
- **Cursor:** add this to `~/.cursor/mcp.json` (merge with what's there, don't overwrite it):
  `{ "mcpServers": { "cloak": { "command": "npx", "args": ["-y", "@cloakely/mcp"] } } }`
- **Claude Desktop:** the same block in `claude_desktop_config.json` (macOS:
  `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), merged in the same way.
- **Any other app:** an MCP server named `cloak`, command `npx`, args `-y @cloakely/mcp`, no settings needed.

**A3. Get play money.** If the balance from A1 is 0, ask the person:

> Please get free testnet HYPE for my wallet. Open https://elysium.kinetiq.xyz/testnet-faucet and paste this
> address: `0x…` (the agentWallet from A1, exactly). Tell me when it's done.

Agents can't use the faucet themselves. 0.05 HYPE is plenty to try everything.

**A4. Load the tools.** Tell the person to restart the app (or start a new chat) so the Cloak tools appear. Then call
`cloak_info`: it should say "read and write" and show the HYPE.

**A5. Do what they asked.** See "Using Cloak" below.

## B. Chat app without commands

You can't hold a wallet here, so you can't trade. Tell the person they have two choices:

1. **Look around from this chat (no wallet):** add Cloak as a connector, then you can list launches, read them and
   price trades.
   - **claude.ai or Claude Desktop:** Settings, Connectors, Add custom connector, paste `https://cloak.boblabs.tech/mcp`.
   - **ChatGPT:** Settings, Apps and connectors, turn on developer mode, add a connector with that link and no
     authentication.
2. **Trade privately:**
   - **themselves**, on https://cloak.boblabs.tech with their own wallet (Portfolio: Shield, then Trade, Send or
     Withdraw), or
   - **through an agent**, by opening Claude Code, Claude Desktop or Cursor and asking it: "Read
     https://cloak.boblabs.tech/agent.md and set me up to trade privately."

## Using Cloak

Private trading always starts the same way:

1. `unlock`: makes the private account from one local signature. Nothing is sent. Gives a `cloak:` address others can
   pay privately.
2. `shield`: moves HYPE or USDC from the wallet into the private balance. This is the one public step.
3. Then, all private and sent by the relayer:
   - `private_swap`: buy or sell a launch token (`side: "buy"` spends HYPE, `"sell"` sells tokens).
   - `batch_order`: trade in standard sizes inside a 30 second round, which also hides the size.
   - `private_send`: pay a `cloak:` address. Sender, recipient and amount stay hidden.
   - `withdraw`: send to a normal `0x` address, ideally a brand new one.
   - `private_balance`: what's held privately.

Launches from Nov 2 on keep their private balances in one shared launch-token vault (testnet experiment). The same
tools work for them. A `private_send` of such a token doesn't even show which token moved, because its relayer is paid
from private HYPE, so keep a little HYPE in the private balance. `batch_order` isn't available for them yet.

Launches: `list_launches`, `get_launch`, `quote_bid`, `place_sealed_bid` (bids stay sealed until bidding closes),
`my_bids`, `claim` (private by default), `create_launch`.

Good to know:

- Amounts are whole units (`"0.1"` HYPE). Send, sell and withdraw accept `"max"`.
- Every private action pays the relayer a small fee in the asset being spent (about 0.0003 HYPE on testnet), so very
  small trades lose a big share to it. Suggest at least 0.01 HYPE per trade.
- Spending limits by default: 1 HYPE per transaction, 10 HYPE per day, 100 USDC per transaction, 1,000 USDC per day,
  3 launches per day. Over a limit, the tool refuses and says which setting raises it. Only raise one if the person
  asks.

## Explaining it to the person

- **Shield:** "I'm moving it into your private balance. This one step is public, everything after it isn't."
- **Private trade:** "The chain sees that a private trade happened, not that it was us, and not how much."
- **Sealed bid:** "Nobody can see our price or size until bidding closes, so nobody can bid just above us."
- **Withdraw:** "This lands at a normal address. A brand new one keeps it from being linked back to you."

## If something goes wrong

- **No Cloak tools:** the app wasn't restarted after A2, or the config wasn't saved. Check and ask for a restart.
- **`cloak_info` says read only:** there's no wallet. Run A1 again (it keeps an existing wallet).
- **"Not enough HYPE" or gas errors:** ask for more from the faucet (A3).
- **"Not enough private balance":** the relayer fee counts too. Try a smaller amount or `"max"`.
- **Anything else:** tell the person what failed in one sentence and point them to https://cloak.boblabs.tech/docs.

More: https://cloak.boblabs.tech/docs · package: https://www.npmjs.com/package/@cloakely/mcp

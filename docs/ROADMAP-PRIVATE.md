# Private roadmap

Internal only. Not on the site or the public roadmap (`apps/web/public/roadmap.html`). Nov 10.

## Mainnet launch

- Cloak v2 on Gloam's Elysium vault, rehearsed end to end on a fork of mainnet (part 22).
- Closing items: the treasury address and memo board (see `docs/MAINNET-DECISIONS.md`, "Closing").
- A backup RPC set for the site (`VITE_RPC_BACKUP`) and the keeper (`RPC_BACKUP`): both fail over automatically. QuickNode lists Elysium endpoints.

## After mainnet (also public)

- **$CLOAK buyback** (`CloakBuyback`): half of revenue buys $CLOAK, half of that burned. Built once $CLOAK trades (`docs/CLOAK.md`).
- **xStocks**: tokenized stocks in the ecosystem vault, listed under its rules.
- **Partner launchpads** in the ecosystem vault.

## Private for now

- **Spicenet (Spice Flow) integration.** It's a partnership, but they haven't answered our questions yet (`Spicenet-questions.pdf`, Nov 10). The blockers are Privy and EIP-7702, and that their Elysium release isn't live (`docs/BRIDGES.md`). Best case is a pay-to-address route into a Cloak receive address, about a day of work. We integrate once they answer. Until then, Relay is the bridge.
- **GLOAK**, the fully private token experiment, after mainnet is live (`docs/CLOAK.md`). It's announced together with Gloam if it works.

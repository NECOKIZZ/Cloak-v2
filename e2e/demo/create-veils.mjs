// A showcase drop on testnet: "Veils", 24 original generative items with their own metadata folder (served from the
// site's /demo-nft/), a cover, a banner, links and a category, so the drop page shows every part of its layout.
//   DEPLOYER_PK=0x… node e2e/demo/create-veils.mjs
import { CloakDrops, deploymentFor, elysiumTestnet } from "@cloakely/sdk";
import { clients, parseEther } from "../lib.mjs";

const dep = deploymentFor(elysiumTestnet.id);
const d = clients(elysiumTestnet, elysiumTestnet.rpcUrls.default.http[0], process.env.DEPLOYER_PK);
const c = new CloakDrops(d.publicClient, d.walletClient, dep.dropFactory, dep.dropFactoryBlock);
const SITE = "https://cloak.boblabs.tech/demo-nft/";
const { drop } = await c.create({
  name: "Veils",
  symbol: "VEIL",
  baseURI: SITE,
  supply: 24,
  floor: parseEther("0.001"),
  maxPerBid: 3,
  royaltyBps: 500,
  biddingSecs: 3 * 86400,
  image: `${SITE}cover.svg`,
  banner: `${SITE}banner.svg`,
  category: "Art",
  links: { website: "https://cloak.boblabs.tech", x: "https://x.com/cloakonelysium" },
  description: "Veils is a demo collection for sealed drops on Cloak: 24 generative pieces, each a stack of sealed shapes. Bid what you'd pay, every winner pays one price. Testnet only, no value.",
});
console.log("Veils", drop, `https://cloak.boblabs.tech/app/drop/${drop}`);
process.exit(0);

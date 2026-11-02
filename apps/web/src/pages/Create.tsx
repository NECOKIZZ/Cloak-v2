import { navigate } from "../router";
import { useApp } from "../state";
import { CreateForm } from "./CreateForm";

export function Create() {
  const { wallet } = useApp();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Create a launch</h1>
          <p>A fair, private launch in one transaction. Bids stay sealed until bidding closes, every winner pays one price, and the token opens on Uniswap at that price with its liquidity locked.</p>
        </div>
      </div>
      <CreateForm wallet={wallet} onCreated={(a) => navigate(`/app/launch/${a}?new=1`)} />
    </>
  );
}

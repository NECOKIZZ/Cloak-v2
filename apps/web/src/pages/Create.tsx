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
          <p>Sealed bids, one price for every winner, then a Uniswap pool with locked liquidity. One transaction.</p>
        </div>
      </div>
      <CreateForm wallet={wallet} onCreated={(a) => navigate(`/app/launch/${a}?new=1`)} />
    </>
  );
}

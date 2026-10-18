import { CreateLaunch } from "../components";
import { navigate } from "../router";
import { useApp } from "../state";

export function Create() {
  const { wallet } = useApp();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Create a launch</h1>
          <p>Deploy a fixed-supply token and its sealed-bid auction in one transaction. Liquidity is seeded at the clearing price and locked or burned automatically.</p>
        </div>
      </div>
      <div className="grid">
        <CreateLaunch wallet={wallet} onCreated={(a) => navigate(`/app/launch/${a}`)} />
        <div className="col">
          <div className="card flat">
            <h3>How it works</h3>
            <ol className="small soft" style={{ paddingLeft: 18, margin: "10px 0 0", display: "grid", gap: 6 }}>
              <li>Bidders seal bids during the bidding window. Nobody can see them.</li>
              <li>When it closes, bids reveal themselves through the drand beacon.</li>
              <li>Settlement finds one clearing price and seeds the pool at it.</li>
              <li>Unsold tokens are burned. Your share of the raise goes to you.</li>
            </ol>
          </div>
          <div className="card flat">
            <h3>For launchpads</h3>
            <p className="small soft" style={{ marginTop: 8 }}>This form is the same call as <code className="mono">cloak.createLaunch()</code> in the SDK, or <code className="mono">CloakFactory.createLaunch</code> from your own contracts.</p>
          </div>
        </div>
      </div>
    </>
  );
}

import { useEffect, useState } from "react";
import { Link } from "../router";
import { Nav } from "../ui";

const VIDEO = "/media/cloak-demo";

/** The walkthrough video: the real site, step by step, with a voice over. Shows a placeholder until the file is uploaded. */
export function Demo() {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    document.title = "Cloak · Demo";
    return () => { document.title = "Cloak · Fair launches and private trading on Elysium"; };
  }, []);

  return (
    <>
      <Nav />
      <div className="wrap demo-page">
        <div className="eyebrow">Walkthrough</div>
        <h1>How to use Cloak</h1>
        <p className="lede">A full screen tour of the live testnet app. Shielding funds, launching a token, bidding privately, trading and sending, start to finish.</p>
        <div className="demo-frame">
          {missing ? (
            <div className="demo-soon">
              <h3>The walkthrough is being recorded</h3>
              <p>Check back soon. Meanwhile you can try the app yourself on Elysium testnet.</p>
              <Link to="/app" className="btn btn-primary">Open the app</Link>
            </div>
          ) : (
            <video controls playsInline preload="metadata" poster={`${VIDEO}.jpg`}>
              <source src={`${VIDEO}.mp4`} type="video/mp4" />
              {/* for browsers without H.264; if neither plays, show the placeholder */}
              <source src={`${VIDEO}.webm`} type="video/webm" onError={() => setMissing(true)} />
            </video>
          )}
        </div>
        <div className="demo-links">
          <Link to="/app" className="btn btn-primary">Open the app</Link>
          <Link to="/docs" className="btn btn-ghost">Read the docs</Link>
        </div>
      </div>
    </>
  );
}

import { short } from "./format";
import { useElyName } from "./names";

/**
 * A wallet as people know it: its .ely name if it has chosen one, else the short address. The full address stays in the
 * tooltip. Names are looked up in the browser straight from the chain, batched, once per address per visit.
 */
export function Who({ address, className = "" }: { address: string; className?: string }) {
  const name = useElyName(address);
  return (
    <span className={`${name ? "who-name" : "mono"} ${className}`.trim()} title={address}>
      {name ?? short(address)}
    </span>
  );
}

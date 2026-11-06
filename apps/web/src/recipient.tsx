import { useRecipient } from "./names";
/** Under a withdrawal address: where a .ely name points, or why it can't be used. */
export function RecipientNote({ input }: { input: string }) {
  const r = useRecipient(input);
  if (r.state === "looking") return <p className="xs mute rcpt">Looking up {r.name}…</p>;
  if (r.state === "missing") return <p className="xs rcpt rcpt-bad">{r.name} isn't registered, or it has expired.</p>;
  if (r.state === "invalid") return <p className="xs rcpt rcpt-bad">Enter a 0x address or a .ely name.</p>;
  if (r.state === "ok" && r.name)
    return (
      <p className="xs mute rcpt">
        {r.name} → <span className="mono">{r.address.slice(0, 6)}…{r.address.slice(-4)}</span>. The withdrawal will be public and tied to this name. A brand-new address keeps you unlinkable.
      </p>
    );
  return null;
}

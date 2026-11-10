/** A small "i" in a circle beside a field's name. Hover it (or tap it on a phone) to read what the field does. */
export function Info({ tip }: { tip: string }) {
  return (
    <span className="info" tabIndex={0} role="note" aria-label={tip} data-tip={tip} onClick={(e) => e.preventDefault()}>
      i
    </span>
  );
}

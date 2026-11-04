import data from "./hidden.json";

/** Test and demo launches and drops Cloak made itself (hidden.json): kept off the lists, still open by direct link. */
const HIDDEN = new Set<string>([...data.launches.flatMap(([, a, t]) => [a, t]), ...data.drops.map(([, d]) => d)].map((x) => x.toLowerCase()));

export const isHidden = (addr?: string) => !!addr && HIDDEN.has(addr.toLowerCase());

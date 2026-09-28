import { useHandle } from "../lib/names";

/**
 * A person, as text: their chosen name, or their short address until one
 * exists. Renders a bare string so it can sit inside any styled Text.
 */
export function Handle({ wallet }: { wallet: string }) {
  return <>{useHandle(wallet)}</>;
}

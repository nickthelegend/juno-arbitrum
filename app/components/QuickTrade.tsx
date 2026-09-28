import { TradeSheet } from "./TradeSheet";
import { juno, type Coin } from "../lib/api";
import { useApi } from "../lib/useApi";
import { useWallet } from "../lib/wallet";

/**
 * The trade sheet, opened from a list rather than from the coin's own screen.
 *
 * The coin screen already knows the wallet's balances when it opens the
 * sheet. A feed card or a reel does not, so this reads them as the sheet
 * opens: ETH (for gas, and the spend on a post), USDC (the spend on a stock
 * tracker) and the coin itself for a sell. Each is null until it answers,
 * which the sheet renders as unknown rather than as zero.
 */
export function QuickTrade({
  coin,
  side = "buy",
  onClose,
  onDone,
}: {
  coin: Coin;
  side?: "buy" | "sell";
  onClose: () => void;
  onDone: () => void;
}) {
  const wallet = useWallet();
  const balances = useApi(
    async () => (wallet.address ? juno.balances(wallet.address, coin.address) : null),
    [wallet.address, coin.address],
  );
  const held = balances.data ?? null;
  const spendsUsdc = coin.quote.symbol === "USDC";

  return (
    <TradeSheet
      coin={coin}
      side={side}
      quoteBalance={held ? (spendsUsdc ? held.usdc : held.eth) : null}
      holding={held?.token ?? null}
      feeBalance={held?.eth ?? null}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

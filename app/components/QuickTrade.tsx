import { TradeSheet } from "./TradeSheet";
import { juno, WSOL_MINT, type Coin } from "../lib/api";
import { useApi } from "../lib/useApi";
import { useWallet } from "../lib/wallet";

/**
 * The trade sheet, opened from a list rather than from the coin's own screen.
 *
 * The coin screen already knows the wallet's balances when it opens the
 * sheet. A feed card or a reel does not, and the sheet showed "Balance: —"
 * on every buy started there. This reads both sides as the sheet opens: the
 * quote token a buy spends, and the coin a sell spends. Each is null until it
 * answers, which the sheet already renders as unknown rather than as zero.
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
  const spendable = useApi(
    async () => (wallet.address ? juno.balance(wallet.address, coin.quote.mint) : null),
    [wallet.address, coin.quote.mint],
  );
  // SOL for the fee, when the market is not itself priced in SOL.
  const sol = useApi(
    async () =>
      wallet.address && coin.quote.mint !== WSOL_MINT ? juno.balance(wallet.address, WSOL_MINT) : null,
    [wallet.address, coin.quote.mint],
  );
  const held = useApi(
    async () => (wallet.address ? juno.balance(wallet.address, coin.address) : null),
    [wallet.address, coin.address],
  );

  return (
    <TradeSheet
      coin={coin}
      side={side}
      quoteBalance={spendable.data?.balance ?? null}
      holding={held.data?.balance ?? null}
      feeBalance={coin.quote.mint === WSOL_MINT ? null : (sol.data?.balance ?? null)}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

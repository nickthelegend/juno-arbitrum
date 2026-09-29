/**
 * A browser wallet for end-to-end runs: an EIP-1193 provider installed as
 * `window.ethereum` before the app loads (Playwright `addInitScript`), holding
 * one private key. It signs with viem in the page and sends raw transactions
 * to the local Nitro node, the way an extension wallet would. Usage:
 *   page.addInitScript({ content: `window.__JUNO_WALLET = { key, rpc, chainId };\n` + source })
 */
(() => {
  const cfg = window.__JUNO_WALLET;
  if (!cfg) return;
  const viem = import("https://esm.sh/viem@2.38.0");
  const accounts = import("https://esm.sh/viem@2.38.0/accounts");
  let ready = null;
  const setup = () =>
    (ready ??= Promise.all([viem, accounts]).then(([v, a]) => {
      const account = a.privateKeyToAccount(cfg.key);
      const chain = v.defineChain({ id: cfg.chainId, name: "Arbitrum Local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpc] } } });
      const wallet = v.createWalletClient({ account, chain, transport: v.http(cfg.rpc) });
      return { v, account, wallet };
    }));
  const listeners = {};
  const rpc = async (method, params) => {
    const r = await fetch(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) });
    const body = await r.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
    return body.result;
  };
  window.ethereum = {
    isJunoTestWallet: true,
    on: (event, fn) => ((listeners[event] ??= []).push(fn)),
    removeListener: (event, fn) => (listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn)),
    request: async ({ method, params }) => {
      const { v, account, wallet } = await setup();
      switch (method) {
        // Like an extension wallet: no accounts for a site until it asks and
        // is approved (here, approved at once), remembered for the session.
        case "eth_accounts":
          return sessionStorage.getItem("juno-test-wallet-connected") ? [account.address] : [];
        case "eth_requestAccounts":
          sessionStorage.setItem("juno-test-wallet-connected", "1");
          (listeners.accountsChanged ?? []).forEach((fn) => fn([account.address]));
          return [account.address];
        case "eth_chainId":
          return v.numberToHex(cfg.chainId);
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        case "personal_sign":
          return account.signMessage({ message: { raw: params[0] } });
        case "eth_sendTransaction": {
          const tx = params[0];
          (window.__JUNO_SENT ??= []).push({ to: tx.to, data: tx.data.slice(0, 10) });
          return wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, ...(tx.gas ? { gas: BigInt(tx.gas) } : {}) });
        }
        default:
          return rpc(method, params);
      }
    },
  };
})();

/**
 * The external contracts Juno relies on, deployed onto a local Nitro dev node
 * from their published build artifacts: WETH9 (@uniswap/v2-periphery) and
 * Uniswap v3's factory and NonfungiblePositionManager (@uniswap/v3-core,
 * @uniswap/v3-periphery; the pool init-code hash is the canonical
 * 0xe34f…8b54, so pool addresses derive exactly as on mainnet).
 * Prints `KEY=0x…` lines for scripts/localnet/up.sh.
 */
import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { localChain } from "../lib";

const require = createRequire(import.meta.url);
const WETH9 = require("@uniswap/v2-periphery/build/WETH9.json");
const FACTORY = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const NPM = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");

const rpc = process.env.ARB_LOCAL_RPC ?? "http://localhost:8747";
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
const chain = localChain(rpc);
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const reader = createPublicClient({ chain, transport: http(rpc) });

async function deploy(label: string, abi: unknown[], bytecode: string, args: unknown[] = []): Promise<Hex> {
  const hash = await wallet.deployContract({ abi, bytecode: (bytecode.startsWith("0x") ? bytecode : `0x${bytecode}`) as Hex, args });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${label} failed: ${hash}`);
  return receipt.contractAddress;
}

const weth = await deploy("WETH9", WETH9.abi, WETH9.bytecode);
const factory = await deploy("UniswapV3Factory", FACTORY.abi, FACTORY.bytecode);
// The token descriptor only renders NFT metadata (tokenURI); Juno never reads it.
const npm = await deploy("NonfungiblePositionManager", NPM.abi, NPM.bytecode, [factory, weth, "0x0000000000000000000000000000000000000000"]);
console.log(`LOCAL_WETH=${weth}`);
console.log(`LOCAL_UNISWAP_FACTORY=${factory}`);
console.log(`LOCAL_POSITION_MANAGER=${npm}`);

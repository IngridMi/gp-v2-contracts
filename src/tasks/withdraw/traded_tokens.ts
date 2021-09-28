import { Contract, providers } from "ethers";
import { HardhatRuntimeEnvironment, HttpNetworkConfig } from "hardhat/types";

import { BUY_ETH_ADDRESS } from "../../ts";

const enum ProviderError {
  TooManyEvents,
  Timeout,
  NetworkError,
}

function decodeError(error: unknown): ProviderError | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const message = error.message;
  // Infura
  if (/query returned more than \d* results/.test(message)) {
    return ProviderError.TooManyEvents;
  }
  // OpenEthereum
  if (/Network connection timed out/.test(message)) {
    return ProviderError.Timeout;
  }
  // POA Network xDai node
  if (
    /^timeout.*/.test(message) &&
    (error as Error & Record<string, unknown>).reason === "timeout" &&
    (error as Error & Record<string, unknown>).code === "TIMEOUT"
  ) {
    return ProviderError.Timeout;
  }
  if (
    /^could not detect network.*/.test(message) &&
    (error as Error & Record<string, unknown>).reason ===
      "could not detect network" &&
    (error as Error & Record<string, unknown>).code === "NETWORK_ERROR"
  ) {
    return ProviderError.NetworkError;
  }
  return null;
}

/// Lists all tokens that were traded by the settlement contract in the range
/// specified by the two input blocks. Range bounds are both inclusive.
/// The output value `lastFullyIncludedBlock` returns the block numbers of the
/// latest block for which traded tokens were searched.
export async function getAllTradedTokens(
  settlement: Contract,
  fromBlock: number,
  toBlock: number | "latest",
  hre: HardhatRuntimeEnvironment,
): Promise<{ tokens: string[]; toBlock: number }> {
  // The calls to getLogs and to getBlockNumber must be simultaneous, so that
  // if running on a node with load balancing then both requests go to the same
  // node and the block number actually represent the latest block for the logs.
  // Note: a batch provider executes all requests at the end of the event loop
  const url = (hre.network.config as HttpNetworkConfig).url;
  // Note: URL is undefined for network hardhat
  const batchProvider =
    url !== undefined
      ? new providers.JsonRpcBatchProvider(url, hre.network.config.chainId)
      : hre.ethers.provider;
  let trades = null;
  let numericToBlock =
    toBlock === "latest" ? batchProvider.getBlockNumber() : toBlock;
  try {
    trades = await batchProvider.getLogs({
      topics: [settlement.interface.getEventTopic("Trade")],
      address: settlement.address,
      fromBlock,
      toBlock,
    });
    console.log(`Processed events from block ${fromBlock} to ${toBlock}`);
  } catch (error) {
    switch (decodeError(error)) {
      // Different nodes throw different types of errors when the query is too
      // large.
      case ProviderError.Timeout:
      case ProviderError.TooManyEvents:
      case ProviderError.NetworkError:
        console.log(
          `Failed to process events from block ${fromBlock} to ${toBlock}, reducing range...`,
        );
        break;
      case null:
        throw error;
    }
  }

  let tokens;
  if (trades === null) {
    if (fromBlock === toBlock) {
      throw new Error("Too many events in the same block");
    }
    const mid = Math.floor(((await numericToBlock) + fromBlock) / 2);
    const { tokens: firstHalf } = await getAllTradedTokens(
      settlement,
      fromBlock,
      mid,
      hre,
    );
    const { tokens: secondHalf, toBlock: numberSecondHalf } =
      await getAllTradedTokens(settlement, mid + 1, toBlock, hre);
    tokens = [...firstHalf, ...secondHalf];
    numericToBlock = numberSecondHalf;
  } else {
    tokens = trades
      .map((trade) => {
        const decodedTrade = settlement.interface.decodeEventLog(
          "Trade",
          trade.data,
          trade.topics,
        );
        return [decodedTrade.sellToken, decodedTrade.buyToken];
      })
      .flat();
  }

  tokens = new Set(tokens);
  tokens.delete(BUY_ETH_ADDRESS);
  return {
    tokens: Array.from(tokens).sort((lhs, rhs) =>
      lhs.toLowerCase() < rhs.toLowerCase() ? -1 : lhs === rhs ? 0 : 1,
    ),
    toBlock: await numericToBlock,
  };
}

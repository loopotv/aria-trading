/**
 * Pre-identify the most likely asset from a news item using keyword matching.
 * Returns the ticker (e.g. "BTC") so the caller can fetch price context BEFORE
 * the LLM call. If no clear asset is found, returns null and the LLM runs
 * without price context.
 */

import type { RawTextItem } from '../ingestion/sources';

const KEYWORD_TO_TICKER: ReadonlyArray<readonly [string, string]> = [
  ['bitcoin', 'BTC'], ['btc', 'BTC'],
  ['ethereum', 'ETH'], ['ether', 'ETH'], [' eth ', 'ETH'],
  ['solana', 'SOL'], [' sol ', 'SOL'],
  ['binance coin', 'BNB'], [' bnb ', 'BNB'],
  ['ripple', 'XRP'], [' xrp ', 'XRP'],
  ['dogecoin', 'DOGE'], [' doge ', 'DOGE'],
  ['cardano', 'ADA'], [' ada ', 'ADA'],
  ['avalanche', 'AVAX'], [' avax ', 'AVAX'],
  ['polkadot', 'DOT'], [' dot ', 'DOT'],
  ['chainlink', 'LINK'], [' link ', 'LINK'],
  ['polygon', 'POL'], [' matic ', 'POL'],
  ['litecoin', 'LTC'], [' ltc ', 'LTC'],
  ['toncoin', 'TON'], [' ton ', 'TON'],
  ['aave', 'AAVE'],
  ['sui', 'SUI'], ['arbitrum', 'ARB'], ['optimism', 'OP'],
  ['uniswap', 'UNI'], ['near protocol', 'NEAR'],
];

export function quickIdentifyAsset(item: RawTextItem): string | null {
  if (item.relatedAssets && item.relatedAssets.length > 0) {
    return item.relatedAssets[0];
  }
  const t = item.text.toLowerCase();
  for (const [kw, ticker] of KEYWORD_TO_TICKER) {
    if (t.includes(kw)) return ticker;
  }
  return null;
}

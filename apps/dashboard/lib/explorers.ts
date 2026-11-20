// Explorer base URLs, kept in sync with packages/chain_config/chains.json
// (explorer_url field). Planned chains included so links work the day
// they go live.
export const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
  56: "https://bscscan.com",
};

export function explorerTx(chainId: number, tx: string): string | null {
  const base = EXPLORERS[chainId];
  return base ? `${base}/tx/${tx}` : null;
}

export function explorerAddress(chainId: number, addr: string): string | null {
  const base = EXPLORERS[chainId];
  return base ? `${base}/address/${addr}` : null;
}

export function explorerBlock(chainId: number, block: number): string | null {
  const base = EXPLORERS[chainId];
  return base ? `${base}/block/${block}` : null;
}

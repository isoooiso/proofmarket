export interface DemoFixtureSpec {
  fixtureId: number;
  seq: number;
  statKeys: number[];
  op: string | null;
  yesThreshold: number;
  /** Stat period passed to create_market (from fixture metadata; settle uses TxLINE proof). */
  period: number;
  label: string;
}

export interface DemoConfig {
  programId: string;
  txlineProgramId: string;
  txlineApiBase: string;
  mockUsdcMint: string;
  mintDecimals: number;
  keeperPubkey: string;
  demoWalletA: string;
  demoWalletB: string;
  fixtures: {
    over: DemoFixtureSpec;
    under: DemoFixtureSpec;
  };
}

/** Frozen demo constants — public on-chain addresses, safe in the client bundle. */
export const demoConfig: DemoConfig = {
  programId: "9ZQJXjeop6xGjFAEvVTgHvWiBnbkVB9AMxo4D8aihxZs",
  txlineProgramId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
  txlineApiBase: "https://txline-dev.txodds.com/api",
  mockUsdcMint: "E9GssRQAi7gv9ni1dL6ExxAKxgqjYYaT28RxW2cZUnap",
  mintDecimals: 6,
  keeperPubkey: "AC3g5jB7mb7U7ZdNVoXDFpdvMjhNuLYaMcoXXw8sMpFi",
  demoWalletA: "AC3g5jB7mb7U7ZdNVoXDFpdvMjhNuLYaMcoXXw8sMpFi",
  demoWalletB: "9opiXe8eok46Z24e6tfVfVAhschSoQKgiBnFxSY8Cfs3",
  fixtures: {
    over: {
      fixtureId: 17926593,
      seq: 1097,
      statKeys: [1, 2],
      op: "Add",
      yesThreshold: 2,
      period: 0,
      label: "Turkey vs USA",
    },
    under: {
      fixtureId: 17588395,
      seq: 261,
      statKeys: [1],
      op: null,
      yesThreshold: 0,
      period: 0,
      label: "single-stat under demo",
    },
  },
};

/**
 * Hand-generated Anchor 0.30.1 IDL for proofmarket — transcribed from lib.rs.
 * Discriminators: sha256("global:" + ix_name)[0..8] / sha256("account:" + AccountName)[0..8]
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PROGRAM_ADDRESS = "9ZQJXjeop6xGjFAEvVTgHvWiBnbkVB9AMxo4D8aihxZs";
const TXLINE_PROGRAM_ID = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const RENT_SYSVAR_ID = "SysvarRent111111111111111111111111111111111";

function disc(prefix, name) {
  const hash = crypto.createHash("sha256").update(`${prefix}:${name}`).digest();
  return Array.from(hash.subarray(0, 8));
}

function bytes(s) {
  return Array.from(Buffer.from(s, "utf8"));
}

const T = {
  bool: "bool",
  u8: "u8",
  i32: "i32",
  u32: "u32",
  i64: "i64",
  u64: "u64",
  pubkey: "pubkey",
  opt: (t) => ({ option: t }),
  vec: (t) => ({ vec: t }),
  arr: (t, n) => ({ array: [t, n] }),
  def: (name) => ({ defined: { name } }),
};

const types = [
  {
    name: "ScoreStat",
    type: {
      kind: "struct",
      fields: [
        { name: "key", type: T.u32 },
        { name: "value", type: T.i32 },
        { name: "period", type: T.i32 },
      ],
    },
  },
  {
    name: "ScoresUpdateStats",
    type: {
      kind: "struct",
      fields: [
        { name: "update_count", type: T.i32 },
        { name: "min_timestamp", type: T.i64 },
        { name: "max_timestamp", type: T.i64 },
      ],
    },
  },
  {
    name: "ScoresBatchSummary",
    type: {
      kind: "struct",
      fields: [
        { name: "fixture_id", type: T.i64 },
        { name: "update_stats", type: T.def("ScoresUpdateStats") },
        { name: "events_sub_tree_root", type: T.arr(T.u8, 32) },
      ],
    },
  },
  {
    name: "ProofNode",
    type: {
      kind: "struct",
      fields: [
        { name: "hash", type: T.arr(T.u8, 32) },
        { name: "is_right_sibling", type: T.bool },
      ],
    },
  },
  {
    name: "Comparison",
    type: {
      kind: "enum",
      variants: [
        { name: "GreaterThan" },
        { name: "LessThan" },
        { name: "EqualTo" },
      ],
    },
  },
  {
    name: "TraderPredicate",
    type: {
      kind: "struct",
      fields: [
        { name: "threshold", type: T.i32 },
        { name: "comparison", type: T.def("Comparison") },
      ],
    },
  },
  {
    name: "StatTerm",
    type: {
      kind: "struct",
      fields: [
        { name: "stat_to_prove", type: T.def("ScoreStat") },
        { name: "event_stat_root", type: T.arr(T.u8, 32) },
        { name: "stat_proof", type: T.vec(T.def("ProofNode")) },
      ],
    },
  },
  {
    name: "BinaryExpression",
    type: {
      kind: "enum",
      variants: [{ name: "Add" }, { name: "Subtract" }],
    },
  },
  {
    name: "Market",
    type: {
      kind: "struct",
      fields: [
        { name: "authority", type: T.pubkey },
        { name: "fixture_id", type: T.i64 },
        { name: "period", type: T.i32 },
        { name: "stat_a_key", type: T.u32 },
        { name: "stat_b_key", type: T.opt(T.u32) },
        { name: "op", type: T.opt(T.def("BinaryExpression")) },
        { name: "yes_threshold", type: T.i32 },
        { name: "usdc_mint", type: T.pubkey },
        { name: "pool_yes", type: T.u64 },
        { name: "pool_no", type: T.u64 },
        { name: "winning_side", type: T.u8 },
        { name: "bump", type: T.u8 },
        { name: "vault_bump", type: T.u8 },
      ],
    },
  },
  {
    name: "Position",
    type: {
      kind: "struct",
      fields: [
        { name: "market", type: T.pubkey },
        { name: "user", type: T.pubkey },
        { name: "side", type: T.u8 },
        { name: "amount", type: T.u64 },
        { name: "claimed", type: T.bool },
        { name: "bump", type: T.u8 },
      ],
    },
  },
];

const marketPdaSeeds = [
  { kind: "const", value: bytes("market") },
  { kind: "account", path: "authority" },
  { kind: "arg", path: "fixture_id" },
  { kind: "arg", path: "yes_threshold" },
];

const marketPdaSeedsFromMarket = [
  { kind: "const", value: bytes("market") },
  { kind: "account", path: "market.authority" },
  { kind: "account", path: "market.fixture_id" },
  { kind: "account", path: "market.yes_threshold" },
];

const vaultPdaSeeds = [
  { kind: "const", value: bytes("vault") },
  { kind: "account", path: "market" },
];

const positionPdaSeeds = [
  { kind: "const", value: bytes("position") },
  { kind: "account", path: "market" },
  { kind: "account", path: "user" },
];

const idl = {
  address: PROGRAM_ADDRESS,
  metadata: {
    name: "proofmarket",
    version: "0.1.0",
    spec: "0.1.0",
    description: "Trustless parimutuel prediction markets settled via TxLINE validate_stat CPI",
  },
  instructions: [
    {
      name: "create_market",
      discriminator: disc("global", "create_market"),
      accounts: [
        { name: "authority", writable: true, signer: true },
        {
          name: "market",
          writable: true,
          pda: { seeds: marketPdaSeeds },
        },
        { name: "usdc_mint" },
        {
          name: "vault",
          writable: true,
          pda: { seeds: vaultPdaSeeds },
        },
        { name: "token_program", address: TOKEN_PROGRAM_ID },
        { name: "system_program", address: SYSTEM_PROGRAM_ID },
        { name: "rent", address: RENT_SYSVAR_ID },
      ],
      args: [
        { name: "fixture_id", type: T.i64 },
        { name: "period", type: T.i32 },
        { name: "stat_a_key", type: T.u32 },
        { name: "stat_b_key", type: T.opt(T.u32) },
        { name: "op", type: T.opt(T.def("BinaryExpression")) },
        { name: "yes_threshold", type: T.i32 },
      ],
    },
    {
      name: "deposit",
      discriminator: disc("global", "deposit"),
      accounts: [
        {
          name: "market",
          writable: true,
          pda: { seeds: marketPdaSeedsFromMarket },
        },
        {
          name: "position",
          writable: true,
          pda: { seeds: positionPdaSeeds },
        },
        {
          name: "vault",
          writable: true,
          pda: { seeds: vaultPdaSeeds },
        },
        { name: "user_usdc", writable: true },
        { name: "user", writable: true, signer: true },
        { name: "token_program", address: TOKEN_PROGRAM_ID },
        { name: "system_program", address: SYSTEM_PROGRAM_ID },
      ],
      args: [
        { name: "side", type: T.u8 },
        { name: "amount", type: T.u64 },
      ],
    },
    {
      name: "settle_market",
      discriminator: disc("global", "settle_market"),
      accounts: [
        {
          name: "market",
          writable: true,
          pda: { seeds: marketPdaSeedsFromMarket },
        },
        { name: "daily_scores_merkle_roots" },
        { name: "txline_program", address: TXLINE_PROGRAM_ID },
        { name: "keeper", signer: true },
      ],
      args: [
        { name: "ts", type: T.i64 },
        { name: "fixture_summary", type: T.def("ScoresBatchSummary") },
        { name: "fixture_proof", type: T.vec(T.def("ProofNode")) },
        { name: "main_tree_proof", type: T.vec(T.def("ProofNode")) },
        { name: "predicate", type: T.def("TraderPredicate") },
        { name: "stat_a", type: T.def("StatTerm") },
        { name: "stat_b", type: T.opt(T.def("StatTerm")) },
        { name: "op", type: T.opt(T.def("BinaryExpression")) },
        { name: "claimed_outcome", type: T.u8 },
      ],
    },
    {
      name: "claim",
      discriminator: disc("global", "claim"),
      accounts: [
        {
          name: "market",
          writable: true,
          pda: { seeds: marketPdaSeedsFromMarket },
        },
        {
          name: "position",
          writable: true,
          pda: { seeds: positionPdaSeeds },
          relations: ["market"],
        },
        {
          name: "vault",
          writable: true,
          pda: { seeds: vaultPdaSeeds },
        },
        { name: "user_usdc", writable: true },
        { name: "user", signer: true },
        { name: "token_program", address: TOKEN_PROGRAM_ID },
      ],
      args: [],
    },
  ],
  accounts: [
    { name: "Market", discriminator: disc("account", "Market") },
    { name: "Position", discriminator: disc("account", "Position") },
  ],
  types,
  errors: [
    { code: 6000, name: "MarketClosed", msg: "Market is closed for deposits" },
    { code: 6001, name: "MarketNotResolved", msg: "Market is not resolved yet" },
    { code: 6002, name: "BadSide", msg: "Invalid side or amount" },
    { code: 6003, name: "FixtureMismatch", msg: "Fixture ID does not match market" },
    { code: 6004, name: "StatMismatch", msg: "Stat configuration does not match market" },
    { code: 6005, name: "PredicateMismatch", msg: "Predicate does not match claimed outcome" },
    { code: 6006, name: "NoReturnData", msg: "validate_stat returned no return data" },
    { code: 6007, name: "WrongReturnProgram", msg: "Return data program id is not TxLINE" },
    { code: 6008, name: "PredicateNotTrue", msg: "validate_stat predicate was not true" },
    { code: 6009, name: "AlreadyClaimed", msg: "Position already claimed" },
    { code: 6010, name: "NothingToClaim", msg: "Nothing to claim" },
  ],
};

function emitTs(idlObj) {
  const json = JSON.stringify(idlObj, null, 2);
  return `/**
 * Program IDL — generated by scripts/gen-idl.js from programs/proofmarket/src/lib.rs
 * Do not edit by hand.
 */
export type Proofmarket = ${json};

export const IDL: Proofmarket = ${json};
`;
}

const idlDir = path.join(ROOT, "target", "idl");
const typesDir = path.join(ROOT, "target", "types");
fs.mkdirSync(idlDir, { recursive: true });
fs.mkdirSync(typesDir, { recursive: true });

const idlPath = path.join(idlDir, "proofmarket.json");
const tsPath = path.join(typesDir, "proofmarket.ts");

fs.writeFileSync(idlPath, JSON.stringify(idl, null, 2) + "\n");
fs.writeFileSync(tsPath, emitTs(idl));

console.log("Wrote", idlPath);
console.log("Wrote", tsPath);
console.log("Instruction discriminators:");
for (const ix of idl.instructions) {
  console.log(`  ${ix.name}: [${ix.discriminator.join(", ")}]`);
}
console.log("Account discriminators:");
for (const acc of idl.accounts) {
  console.log(`  ${acc.name}: [${acc.discriminator.join(", ")}]`);
}

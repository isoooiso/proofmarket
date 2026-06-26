# TxLINE IDL

The de-risk scripts load the TxLINE program IDL automatically via
`anchor.Program.fetchIdl(PROGRAM_ID, provider)` (reads the on-chain IDL account).

If that returns `null` (no on-chain IDL published), provide it locally as
`idl/txoracle.json`. Two ways to get it:

```bash
# Option A: anchor CLI (reads the on-chain IDL account)
anchor idl fetch 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J \
  --provider.cluster devnet -o idl/txoracle.json
```

Option B: copy the JSON from the "IDL" tab at
<https://txline-docs.txodds.com/documentation/programs/devnet.md> into
`idl/txoracle.json`.

Devnet program id: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
Mainnet program id: `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`

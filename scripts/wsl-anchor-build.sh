#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
cd /mnt/c/Users/petre/Desktop/proofmarket
SBF_CARGO="$HOME/.cache/solana/v1.41/platform-tools/rust/bin/cargo"
rm -f Cargo.lock
"$SBF_CARGO" generate-lockfile
"$SBF_CARGO" update -p zeroize_derive --precise 1.4.2
"$SBF_CARGO" update -p indexmap --precise 2.3.0
"$SBF_CARGO" update -p unicode-segmentation --precise 1.11.0
anchor build --no-idl -- --tools-version v1.48 --force-tools-install

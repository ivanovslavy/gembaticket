#!/bin/bash
# ============================================
# GembaTicket v2 — Slither Security Analysis
# ============================================
# Prerequisites:
#   pip install slither-analyzer
#   solc-select install 0.8.28 && solc-select use 0.8.28
#   npm install (in project root)
#
# Usage:
#   bash scripts/run-slither.sh
#   bash scripts/run-slither.sh --json  (save JSON report)

set -e

echo "============================================"
echo "GembaTicket v2 — Slither Security Analysis"
echo "============================================"
echo ""

# Check prerequisites
command -v slither >/dev/null 2>&1 || { echo "ERROR: slither not found. Install: pip install slither-analyzer"; exit 1; }
command -v solc >/dev/null 2>&1 || { echo "ERROR: solc not found. Install: solc-select install 0.8.28 && solc-select use 0.8.28"; exit 1; }

SOLC_VERSION=$(solc --version | grep -oP 'Version: \K[0-9.]+' 2>/dev/null || echo "unknown")
echo "solc version: $SOLC_VERSION"
echo ""

# Output directory
mkdir -p reports

TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Run Slither on each contract separately for cleaner output
CONTRACTS=(
  "contracts/PlatformRegistry.sol"
  "contracts/EventContract721.sol"
  "contracts/EventContract1155.sol"
  "contracts/ClaimContract.sol"
)

TOTAL_HIGH=0
TOTAL_MEDIUM=0
TOTAL_LOW=0
TOTAL_INFO=0

for CONTRACT in "${CONTRACTS[@]}"; do
  BASENAME=$(basename "$CONTRACT" .sol)
  echo "--------------------------------------------"
  echo "Analyzing: $BASENAME"
  echo "--------------------------------------------"

  if [ "$1" == "--json" ]; then
    slither "$CONTRACT" \
      --config-file slither.config.json \
      --json "reports/slither-${BASENAME}-${TIMESTAMP}.json" \
      2>&1 || true
  else
    slither "$CONTRACT" \
      --config-file slither.config.json \
      2>&1 || true
  fi

  echo ""
done

# Full project analysis
echo "============================================"
echo "Full project analysis"
echo "============================================"

if [ "$1" == "--json" ]; then
  slither . \
    --config-file slither.config.json \
    --json "reports/slither-full-${TIMESTAMP}.json" \
    --print human-summary \
    2>&1 || true
  echo ""
  echo "JSON reports saved in reports/"
  ls -la reports/slither-*-${TIMESTAMP}.json
else
  slither . \
    --config-file slither.config.json \
    --print human-summary \
    2>&1 || true
fi

echo ""
echo "============================================"
echo "Analysis complete"
echo "============================================"
echo ""
echo "Common false positives to expect:"
echo "  - 'Reentrancy' on ClaimContract.claim() — we use effects before interactions"
echo "  - 'Low-level calls' on payment splits — intentional for gas efficiency"
echo "  - 'Block timestamp' on claimHash — acceptable for non-critical randomness"
echo "  - 'Dangerous strict equalities' on fee calculations — exact math is correct"
echo ""
echo "CRITICAL findings that need fixing: anything marked 'High' or 'Critical'"
echo "Review 'Medium' findings case by case"

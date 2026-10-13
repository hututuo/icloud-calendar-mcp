#!/usr/bin/env bash
set -euo pipefail
project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_root"
rm -rf dist
mkdir -p dist/server dist/.openai
node scripts/bundle.mjs
if [[ -f .openai/hosting.json ]]; then
  cp .openai/hosting.json dist/.openai/hosting.json
else
  cp .openai/hosting.example.json dist/.openai/hosting.json
fi
echo "Built $project_root/dist"

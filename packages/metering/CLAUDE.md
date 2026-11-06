# @dominusnode/metering

Team: **Core Platform**

Cost calculation and usage recording.

## Key Files
- `src/index.ts` — computeCostCents, recordUsage, debitForUsage

## Rules
- Prices are never hardcoded: read per-class rates from `network_pricing` (defaults $0.50/GB residential, $0.20/GB dc)
- Relay money (splits, node credits) is integer micro-USD (`_musd` BIGINT); only `wallets.balance_cents` is cents
- createUsageRecord: validate bytes_in/bytes_out/cost_cents (non-negative, <= MAX_INT)
- endSession: usage record insert + wallet debit should be atomic (known TODO)

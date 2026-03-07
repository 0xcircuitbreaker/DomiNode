# @dominusnode/metering

Team: **Core Platform**

Cost calculation and usage recording.

## Key Files
- `src/index.ts` — computeCostCents, recordUsage, debitForUsage

## Rules
- DC: $3/GB (300 cents), Residential: $5/GB (500 cents)
- createUsageRecord: validate bytes_in/bytes_out/cost_cents (non-negative, <= MAX_INT)
- endSession: usage record insert + wallet debit should be atomic (known TODO)

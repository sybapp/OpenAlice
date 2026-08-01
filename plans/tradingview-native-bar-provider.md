# TradingView native bar provider

Status: completed

## Scope

Provide an optional, keyless TradingView-backed K-line source through the
canonical BarService/provider seam. This work covers anonymous chart-feed
fetching, symbol search and aliases, interval/date validation, retry behavior,
source capability metadata, vendor discovery/configuration, and the matching
demo/API surface. It does not add broker state, native order-flow data, or a
second market-data compatibility server.

## Decisions

- TradingView is implemented under `src/domain/market-data/bars/providers/`;
  the embedded compatibility package remains private and is not extended with
  a TradingView provider.
- Bare symbols are resolved through TradingView search; exchange-qualified
  identifiers remain stable source IDs for callers.
- Count is sent to TradingView only when the provider consumes it server-side;
  other compatibility providers retain their existing parameter contracts.
- Transient timeout, socket, and early-close failures may retry twice with
  linear backoff. Symbol, series, and protocol failures fail immediately.
- Provider capability metadata is conservative for unknown vendors, with
  `delayed` as the fallback rather than an invented realtime guarantee.
- UI/vendor discovery is a configuration surface for the bar source, not a
  chart or trading-signal surface.

## Delivered checklist

- [x] Add native TradingView historical fetch and symbol-search adapters.
- [x] Validate intervals and date-only inputs before opening a socket.
- [x] Resolve chart completion and close/error paths deterministically.
- [x] Add bounded retry handling for transient websocket failures.
- [x] Expose capability/alias metadata through BarService and vendor routes.
- [x] Cover provider, BarService, route, and demo-handler behavior with tests.
- [x] Document provider ownership and keep it outside the compatibility package.

## Verification

- `npx tsc --noEmit`
- `pnpm test`
- Focused TradingView provider and BarService suites

## Related guidance

- [[docs/market-data-architecture.md]]
- [[docs/project-structure.md]]
- [[docs/cli-installer.md]]

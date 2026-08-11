# Security Policy

This repository is a testnet proof of concept and is not ready for material-value production use.

## Reporting

Please open a private security advisory on GitHub when the repository is hosted, or contact the maintainer through the project owner's preferred private channel.

Do not include funded private keys, seed phrases, live credentials, or private prompt data in public issues.

## Current Scope

Security review currently covers:

- `src/pricing/`
- `src/gateway/`
- `src/client/`
- MPP Session and MPP Charge integration behavior used by this POC

See [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) for the current findings record.

## Known Non-Production Areas

- In-memory stores.
- Mock model backend.
- Placeholder exchange-rate configuration.
- Single-tenant conversation state.
- Testnet-only deployment assumptions.

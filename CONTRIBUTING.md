# Contributing

Thanks for taking a look at the project.

## Local Checks

Run these before opening a pull request:

```bash
npm test
npm run typecheck
```

## Development Notes

- Keep payment-path arithmetic in exact integer units.
- Do not commit `.env` files or funded Stellar secrets.
- Prefer narrow changes with focused tests.
- Update `docs/TECHNICAL_DESIGN.md` when architecture, payment ordering, or settlement assumptions change.
- Update `docs/SECURITY_AUDIT.md` when a security-relevant finding is fixed, deferred, or newly discovered.

## Pull Requests

Please include:

- What changed.
- Why the change is needed.
- How it was tested.
- Any remaining limitations or follow-up work.

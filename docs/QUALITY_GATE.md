# FAR2 quality gate

The canonical repository verification command is:

```text
pnpm verify
```

The gate is non-mutating. It runs the transitional ESLint debt baseline check, Vue/TypeScript type checking, the curated offline core regression suite, and the web production build.

`pnpm lint` is the strict read-only ESLint command and currently exposes historical repository debt. `pnpm lint:baseline` is the CI gate while that debt is being removed: the committed `.quality/eslint-baseline.json` records the pre-existing findings, and CI fails if any finding group is new or increases. Existing findings are allowed only to stay equal or decrease. `pnpm lint:fix` is the explicit mutating command and is never used by CI.

The curated regression suite includes deterministic local tests for startup scoping, crop-registry parity, catalog/land/planting/mutation behavior, farm services and scheduling, QR/code-manager throttling, isolated code-provider behavior, persistence integrity, and Phase 1/2 security regressions. Scripts that require a live QQ/WeChat session, Windows process inspection, capture/probe tooling, or production credentials remain explicit operator tools and are not part of the per-PR gate.

GitHub Actions runs the same `pnpm verify` command on pull requests to `main` and pushes to `main`, using Node 24 and pnpm 10.30.2 with `--frozen-lockfile`. The lint baseline is transitional and should be reduced in later cleanup phases rather than regenerated casually.

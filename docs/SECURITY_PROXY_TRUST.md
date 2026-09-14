# Trusted proxy and login-attempt hardening

FAR2 does not trust client-supplied forwarding headers by default. The login rate limiter uses Express `req.ip`, and Express is configured with proxy trust disabled unless `TRUST_PROXY` explicitly names trusted proxy IPs, CIDRs, or Express named subnets.

Directly exposed FAR2: leave `TRUST_PROXY` unset.

For a reverse proxy on loopback, use `TRUST_PROXY=loopback`. For an explicitly controlled proxy subnet, use a value such as `TRUST_PROXY=172.20.0.0/16`. Multiple entries may be comma-separated.

FAR2 intentionally rejects trust-all values such as `true` and `*`, as well as numeric hop-count configurations. Configure the actual trusted proxy IP/CIDR instead. Do not rely on client-supplied `CF-Connecting-IP`, `X-Real-IP`, or `X-Forwarded-For` unless Express has verified the immediate proxy chain through this allowlist.

Login-attempt persistence is bounded. Non-locked per-username failure records expire after the lockout retention window, malformed or stale records are pruned, and the persisted attempt map is capped at 4096 entries. Active lockouts are retained preferentially when pruning under pressure.

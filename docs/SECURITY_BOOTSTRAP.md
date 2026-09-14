# Secure administrator bootstrap

FAR2 no longer creates a fixed `admin / admin` credential on a fresh data directory.

On a new installation, set `ADMIN_BOOTSTRAP_PASSWORD` to a strong password of at least 12 characters that satisfies FAR2's password policy before starting the service. FAR2 creates the initial `admin` account only when no administrator account exists. Existing installations that already contain an administrator are not changed by this bootstrap gate.

Do not commit the bootstrap password to Git. Supply it through the deployment environment or secret-management mechanism used by the host.

For Docker Compose, provide it from the shell or another deployment secret source, for example:

```sh
ADMIN_BOOTSTRAP_PASSWORD='replace-with-a-strong-password' docker compose up -d
```

If no administrator exists and `ADMIN_BOOTSTRAP_PASSWORD` is missing or weak, startup fails closed instead of creating a known default credential.

The retired legacy WeChat `/api/proxy` path has also been removed. It must not be reintroduced as an unauthenticated arbitrary upstream proxy.

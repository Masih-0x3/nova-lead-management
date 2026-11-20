# Security Policy

## Supported versions

Nova Lead Management is pre-1.0. Security fixes are made only against the
latest release on the `main` branch; older versions are not patched.

| Version | Supported |
| ------- | --------- |
| latest `main` / most recent release | Yes |
| anything older | No |

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for security problems.**

Report vulnerabilities privately using one of:

1. GitHub private vulnerability reporting: the repository's
   **Security → Report a vulnerability** form.
2. Email **security@example.com** (placeholder — replace with the project's
   security contact before publishing).

Please include affected versions or commits, reproduction steps, impact, and any
suggested fix. We aim to acknowledge reports within 3 business days and will keep
you informed until a fix is released. Please give us reasonable time to remediate
before any public disclosure.

## Secrets handling

- Never commit `.env*` files (only `.env.example`, which must hold placeholders).
  `.gitignore` excludes them; do not override that.
- All secrets (Supabase keys, API keys, database credentials, passwords) are
  provided through environment variables, never hard-coded in source, scripts,
  fixtures, docs, or CI logs.
- Tests and fixtures must use synthetic data and dummy credentials only — never
  real customer data, production credentials, or private auth state.
- If a secret is committed or leaked, treat it as compromised: rotate it
  immediately and report it through the private channel above. Removing it from
  git history alone is not sufficient.

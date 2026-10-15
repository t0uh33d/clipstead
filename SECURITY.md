# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: on the repository page, open **Security → Report a
vulnerability**. Do not open a public issue or pull request for security problems.

Include the affected component (Worker, web app or Mac app), the version or commit, steps to reproduce, and the
impact you expect. We aim to acknowledge reports within a week and to agree on a disclosure date with you.

Especially in scope:

- Any way for one user to read or change another user's clipboard, devices, sessions or settings.
- Authentication or pairing bypasses, including getting a device credential without approval.
- Clipboard content executed or rendered as HTML.
- Secrets or clipboard content leaking into logs, URLs or third parties.

Out of scope: an instance operator reading their own database (documented, see [docs/security.md](docs/security.md)),
denial of service through Cloudflare plan limits, and issues that need a compromised Mac or browser.

## Supported versions

Only the latest release receives security fixes. Self-hosters should follow the upgrade steps in
[docs/self-hosting.md](docs/self-hosting.md#upgrading).

## Security model

[docs/security.md](docs/security.md) describes the threat model, the mitigations, and the known limitations.

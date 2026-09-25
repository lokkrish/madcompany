# Security

madcompany runs AI agents unattended on your machine, so security issues matter. Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security tab), not in public issues.

## What madcompany protects against

- **Actions that need a human** (push, deploy, cloud changes, publishing, global installs, reading `.env` secrets, deleting outside the project) are blocked by a pre-tool hook (`src/hook.js`) before they run.
- **HQ** binds to 127.0.0.1, checks the Host header (DNS rebinding) and rejects cross-origin requests. The only cross-origin endpoint is the feedback widget's, and it only accepts localhost origins.
- **Credentials:** madcompany never reads, stores or forwards Claude or Codex credentials. Agents run inside your own host session.
- **Files:** HQ's file viewer refuses paths outside the project, `.git`, `node_modules` and `.env` files, and escapes raw HTML in markdown.

## Known limits

- The deny list is pattern-based. A determined or confused agent can phrase a command it doesn't catch, so review what your agents may run (`.claude/settings.json` → `permissions.allow`) and use Claude Code's sandbox where available.
- Agents report their own check results before review. The merge queue re-runs the checks after merging.
- Content agents fetch from the web is untrusted. Keep web access off for roles that don't need it.

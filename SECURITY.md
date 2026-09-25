# Security

madcompany runs AI agents unattended on your machine, so security issues matter. Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security tab), not in public issues.

## What madcompany protects against

- **Actions that need a human** (push, deploy, cloud changes, publishing, global installs, reading `.env` secrets, deleting outside the project) are blocked by a pre-tool hook (`src/hook.js`) before they run.
- **HQ** binds to 127.0.0.1, checks the Host header (DNS rebinding) and rejects cross-origin requests. The only cross-origin endpoint is the feedback widget's, and it only accepts localhost origins.
- **Shared HQ** (`hq --share`): everyone signs in with a personal link. Tokens are 256-bit random values stored only as SHA-256 hashes in `.madcompany/run/access.json` (mode 600); a new link replaces the old one and removing a person revokes it. The session cookie is HttpOnly and SameSite=Strict, writes must come from HQ's own origin, and each person's role (owner, member, viewer) is checked on every request. The MCP server, CLI API and feedback widget answer only from the machine HQ runs on.
- **Credentials:** madcompany never reads, stores or forwards Claude or Codex credentials. Agents run inside your own host session.
- **Files:** HQ's file viewer refuses paths outside the project, `.git`, `node_modules` and `.env` files, and escapes raw HTML in markdown. Links (symlinks) that lead outside the project are never served, listed in the Library, searched or scanned for references.

## Known limits

- Shared HQ serves plain HTTP, so on an untrusted network the sign-in cookie can be sniffed. Use a private network (e.g. Tailscale) or an HTTPS tunnel for anyone outside your own network.
- The deny list is pattern-based. A determined or confused agent can phrase a command it doesn't catch, so review what your agents may run (`.claude/settings.json` → `permissions.allow`) and use Claude Code's sandbox where available.
- Agents report their own check results before review. The merge queue re-runs the checks after merging.
- Content agents fetch from the web is untrusted. Keep web access off for roles that don't need it.

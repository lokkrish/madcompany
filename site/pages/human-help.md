---
title: Human help · madcompany
description: Everything only you can do (accounts, API keys, service setup, payments, pushes, deploys, access) in one place in HQ, with exact steps.
---

# Human help

<p class="lead">Some things only a person can do: sign up for a service, create an API key, pay for something, push to GitHub, deploy. Agents are blocked from those by the safety hook. Instead of stopping to ask in chat, they file each one in <b>HQ → Human help</b> with exact steps, and keep building on mocks. Anything that truly can't continue is parked on the item and resumes the moment you mark it done.</p>

<img class="shot" src="img/hq-human-help.png" alt="HQ Human help: open items with steps, the .env keys still missing, and Mark done">

## What goes there

| Kind | Examples |
|---|---|
| Accounts & sign-ups | Stripe, Twilio, Expo, Apple Developer, Google Play, Vercel, a cloud account |
| Keys & secrets | API keys, webhook secrets, database connection strings: added to `.env` by you |
| Service setup | OAuth apps and redirect URLs, webhooks, DNS records, email sender domains |
| Payments & purchases | Paid plans, domains, app store fees |
| Push, deploy & publish | `git push`, deploying a release, publishing to npm or the app stores |
| Access, data & legal | Repo or cloud access, test accounts, a copy of real data, privacy policy and terms |

## How items arrive

- **Agents file them** with the `mc_human_help` tool the moment they know they need something: the title, why, numbered steps with links, the `.env` key names, which tickets need it, and which release needs it by.
- **Planning files them early.** `/mc-plan-release`, `/mc-plan-epic` and `/mc-scan` list every service, account and deploy target the work will need, so you can do them while the team builds on mocks.
- **Shipping files one.** After `npx madcompany ship R1`, "Push and deploy R1" appears with the exact push command and your own deploy steps from `deploy:` in `team.yaml`.
- **You can add your own** from the page ("renew the domain").

The same request from two agents becomes one item, with both tickets on it.

## Keys are checked, never read

When an item lists keys like `STRIPE_SECRET_KEY`, HQ looks for them in your env files (`.env` and `.env.local` by default, `env_files:` in `team.yaml`). It shows ✓ once a key has a value, and never reads, shows or sends the value. If you press **Mark done** while a key is still missing, HQ asks first, because you may have put it somewhere else.

Agents can't read `.env` at all: the safety hook blocks it.

## When you mark one done

1. The item moves to **Done** with your note ("test keys added").
2. Every ticket parked on it becomes ready, and the lead is told to restart its agent.
3. The agent resumes from its checkpoint, with your note in hand.

Items are also saved as `.madcompany/human-help.md`, readable without HQ, and every `HELP-n` is a clickable reference everywhere in HQ.

## Always yours

The safety hook blocks these for every agent. When one is really needed, it comes to Human help instead:

- Creating accounts and signing up for services
- Reading or writing secrets in `.env`
- Paying for anything
- Pushing to a remote (unless you set `allow_push: true`)
- Deploying, changing cloud resources, publishing packages or apps
- Installing things globally, or deleting anything outside the project

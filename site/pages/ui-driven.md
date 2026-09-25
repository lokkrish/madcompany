---
title: UI-driven development · madcompany
description: Clickable screens first, on mock data, then the logic behind them, release by release.
---

# UI-driven development

<p class="lead">For apps where the screens are the product: consumer and business apps, dashboards, mobile apps. You see and shape the whole UI as a clickable prototype before any real logic is built, then the team wires it up release by release.</p>

**Plan with:** a product brief and a UX spec. No full PRD needed to start.

## Releases

<!-- ladder:ui -->

## Steps

<!-- steps:ui -->

## You and the team

<div class="split">
<div>

### You

- Write the brief and the UX direction (`/bmad-product-brief`, `/bmad-ux`), or just describe the app to the lead
- Sit in the **UI sprint**: open HQ → Preview (or Expo Go on your phone), click **Comment** on anything; each comment becomes a ticket
- Sign the screens off
- Review each release in HQ → Releases
- Do the [Human help](human-help.html) items: accounts and keys for the services the app will use, then push and deploy

</div>
<div>

### The team

- R1: real screens in your stack (Next.js, Expo…) on hard-coded data and a mock API client, with a screenshot on every UI ticket
- After sign-off: writes the API contract the screens need, then builds the backend to it
- Later releases replace mocks with real logic, one flow at a time, keeping the signed-off screens intact
- Files Human help for every service it will need, as soon as it knows

</div>
</div>

## Tips

- Keep R1 to screens and navigation. Resist wiring anything real until you have clicked through everything.
- Comment on the Preview rather than describing changes in chat: the comment carries the screen, element and screen size.
- Your sign-off is recorded as a decision with screenshots, and the UI sprint is saved as minutes in the Library.
- Mobile: Expo web preview in the browser, Expo Go on your phone, or the iOS Simulator / Android emulator on your machine.

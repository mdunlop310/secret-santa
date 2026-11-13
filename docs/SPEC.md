# Secret Santa App: Project Spec

Last updated 1 Nov 2026.

## Overview

A free, ad-free web app that lets a group of friends or family run a Secret Santa: the organiser sets a budget and exclusions, everyone gets in with the group's codeword and taps their name (no account), the app draws names, and each person's wish list is visible only to their Secret Santa.

**Goals**

- Set up a group, invite people and run the draw in under five minutes
- Respect exclusions (for example couples never paired) and always produce a valid draw or explain why none exists
- Keep every giftee secret, even from the admin
- Let givers see a giftee's wish list, with links and prices checked against the group budget
- Send email reminders so nobody forgets a wish list or the gift date

**Non-goals (v1)**

- User accounts, passwords or social login
- Payments, gift purchasing or affiliate links
- Anonymous chat between giver and giftee
- Native mobile apps (the site must be mobile-friendly instead)

## Roles and user flows

Two roles, both without accounts: the **admin** (creates the group, holds a private admin link) and **participants** (each holds a private personal link). The admin can also be a participant.

| Role | Access | Can do |
| --- | --- | --- |
| Admin | Private admin link | Edit group details, set budget and date, add or remove participants, set exclusions, run the draw, resend invites |
| Participant | Private personal link | Edit own name and wish list, see own giftee and their wish list, see group budget and date |

**Admin flow**

1. Create group: name, budget (min/max in GBP), gift-exchange date, optional message, admin name and email, "I'm taking part too"
2. Add participants by name and email, or share the generic invite link
3. Set exclusions by clicking pairs in a visual grid (see Matching)
4. Run the draw once enough participants have joined
5. Optionally redraw before the lock date if someone drops out

**Participant flow**

1. Go to the site, enter the group's codeword, then tap your name or join with your name (email optional). The device remembers you after that
2. Add wish list items (title, optional URL, optional price) or choose "secret surprise" to skip the list
3. After the draw, open the personal link to see the giftee's name and wish list
4. Receive reminders by email until the gift date

## Functional requirements

| ID | Area | Requirement |
| --- | --- | --- |
| F1 | Groups | Admin creates a group with name, gift date, budget (GBP only, min, max) and an optional message |
| F2 | Invites | Organiser picks a codeword to share (unique, case and spacing ignored, changeable); the old invite link still works; admin can also add people by email; a group has 3 to 50 participants |
| F3 | Identity | No passwords: each person gets a unique, unguessable magic link by email, which can be re-sent |
| F4 | Wish lists | Each participant adds, edits, reorders and deletes items: title, optional URL, optional price; a participant can instead choose "secret surprise" to skip the list. Lists stay editable after the draw and the giver is emailed when their giftee changes it |
| F5 | Budget check | Items with a price above the group's maximum show a warning to the giftee; the giver sees the flag too |
| F6 | Link preview | For a pasted URL, the server fetches the page title and image where available; failure never blocks saving |
| F7 | Visibility | A wish list is visible only to its owner and to the owner's Secret Santa, never to other participants or the admin |
| F8 | Exclusions | Admin marks pairs that must not be matched in a visual grid; exclusions are symmetric by default, with an option for one-way; a group setting lets the admin choose whether participants can see the exclusions (hidden by default) |
| F9 | Draw | Admin runs the draw; the result is stored once and shown only to each giver; admin cannot see results |
| F10 | Redraw | Admin can redraw (everyone is notified) until a lock date, or after removing a participant |
| F11 | Reminders | Emails: invite, draw done, wish list nudge, gift date approaching (admin sets cadence) |
| F12 | Lifecycle | Groups auto-delete personal data 30 days after the gift date |

## Matching and exclusions

The draw is a derangement problem on a directed graph: each person gives to exactly one person and receives from exactly one, never themselves, never an excluded pair.

**Exclusion UI.** A grid with participants on both axes (rows are givers, columns are giftees). The admin clicks a cell to block a pair; blocking A to B also blocks B to A unless "one-way" is chosen. Shortcut: "Group these people" (for example a couple or household) blocks all pairs within the set. The screen shows whether a valid draw is still possible.

**Algorithm**

1. Build a graph with an edge from giver to giftee wherever the pair is allowed
2. Shuffle the participants with a cryptographically secure random source
3. Find a single directed cycle through everyone (Hamiltonian cycle) by randomised backtracking, which also avoids two-person swaps; if none exists, fall back to any perfect matching via bipartite matching
4. Cap the search at about 1 second; for the 3 to 50 participants supported, this is effectively instant
5. Store only the final giver-to-giftee pairs

**Edge cases**

- No valid draw (too many exclusions): tell the admin which people are the bottleneck, for example someone excluded from all but one person who is also taken
- Someone is added or removed after the draw: require a redraw, with a confirmation warning
- Direct swaps (A gives to B and B gives to A): allowed only when the group has fewer than 4 people, otherwise avoided
- Admin must not see results: the draw runs server-side and the results are never returned by any admin endpoint

## Data model

Six tables in PostgreSQL. Tokens are random 128-bit values stored hashed (except the invite token).

| Table | Key fields | Notes |
| --- | --- | --- |
| groups | id, name, budget_min, budget_max, gift_date, message, admin_name, admin_email, admin_token_hash, invite_token, show_exclusions, draw_status, created_at | Budget in pence, GBP only. draw_status: not_drawn, drawn. show_exclusions defaults to false |
| participants | id, group_id, name, email, token_hash, secret_surprise, joined_at | Unique email per group. secret_surprise defaults to false |
| exclusions | id, group_id, giver_id, giftee_id | One row per blocked direction |
| assignments | id, group_id, giver_id, giftee_id, draw_round | One active round per group; older rounds kept for audit only until deletion |
| wishlist_items | id, participant_id, title, url, price, image_url, sort_order | Price in pence |
| reminders | id, group_id, participant_id, type, send_at, sent_at | Drives the scheduled email job; includes wish-list-changed notifications |

## Architecture and API

A React single-page app talks to a Python REST API; a scheduled worker sends reminder emails.

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | React + TypeScript, Vite | Mobile-first forms and the exclusion grid |
| Backend | FastAPI with Pydantic | Typed, quick to build, auto-generated API docs |
| Database | PostgreSQL with SQLAlchemy and Alembic migrations | Relational data, constraints on exclusions and assignments |
| Email | Transactional provider (Resend, Postmark or SES) | Deliverability for magic links and reminders |
| Jobs | APScheduler or a daily cron hitting an internal endpoint | Reminders need only day-level precision |
| Hosting | Frontend on Vercel or Netlify; API and DB on Fly.io, Render or Railway; on a subdomain of dunlopdev.com | Cheap or free for a small group |

**Key endpoints** (tokens are sent as `Authorization: Bearer <token>`; where a path has a group id it must match the token's group)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | /groups | none | Create group, return admin link |
| GET, PATCH | /groups/{id} | admin or participant token | Read or update group details |
| POST | /join/{invite_token} | none | Join group, send magic link |
| GET, PUT | /me | participant token | Own profile and wish list |
| GET, PUT | /groups/{id}/exclusions | admin token | Read or set exclusion pairs |
| POST | /groups/{id}/draw | admin token | Run or redo the draw |
| GET | /me/giftee | participant token | Giftee name and wish list |

## Privacy, security and quality

The core promise is that nobody, including the admin, can see who has whom.

- **Secrecy:** no endpoint returns the full assignment list; each giver's request returns only their own giftee. Consider encrypting assignment rows with a per-group key held server-side.
- **Tokens:** 128-bit random, stored hashed, sent only over HTTPS; links can be regenerated by the admin if leaked.
- **Abuse:** rate-limit group creation and email sends; cap participants per group; validate and sanitise URLs and fetched link previews (block private IP ranges to prevent server-side request forgery).
- **Data:** store only name, email and wish list; auto-delete 30 days after the gift date; let anyone remove themselves and their data.
- **Email:** every email has an unsubscribe link that stops reminders only.
- **Accessibility and devices:** works on phones first; keyboard-navigable exclusion grid; WCAG AA contrast.
- **Testing:** unit tests for the matching algorithm (including impossible exclusion sets and 3-person groups) and integration tests that assert no endpoint leaks assignments.

## MVP scope and milestones

1. Group creation, invite links, magic-link identity
2. Wish lists with link previews and budget flag
3. Exclusion grid and matching algorithm with tests
4. Draw, giftee view and redraw
5. Email reminders, auto-deletion, polish and deploy

**Out of scope for now:** anonymous chat, accounts, gift-date venue details, multiple wish-list tabs, multi-language.

## Decisions

- The admin always sees the exclusions they set, never the draw results; the admin chooses whether participants can see the exclusions
- Wish lists stay editable after the draw, and the giver is emailed about changes
- A "secret surprise" option lets someone skip their wish list; the giver sees a note saying so
- GBP only
- The app is called "Secret Santa" for now, hosted on a dunlopdev.com subdomain (for example secretsanta.dunlopdev.com); the name can change later

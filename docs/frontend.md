# Cosign frontend

The app is the design boards wired to the API: the same components, layout and words as `/mockups/v2`, with real data.
The boards stay as they were (sample data in the browser) for design work.

| Route | What | Code |
|---|---|---|
| `/` | redirects to `/chat` | `src/app/page.tsx` |
| `/sign-in` | wallet sign-in (EIP-6963 wallets, Sign-In with Ethereum) | `src/app/sign-in/page.tsx` |
| `/chat` | rooms (still the board's sample) and agents (real): conversation, voice, Grok Bot jobs, cards | `src/app/(app)/chat/` |
| `/permissions` | People, Agents (spending and settings), Treasury | `src/app/(app)/permissions/` |

## Foundation

- `src/lib/client/api.ts`: one typed client for `/api/v1`. Response types are imported from the server functions
  (type-only), so they can't drift. Errors carry the server's own words (`ApiError`). A read that failed only because
  Arc's public RPC was busy (429) is asked again with backoff.
- `src/lib/client/data.ts`: a small shared read cache (`useData(key, fetcher)`, `invalidate(prefix)`), no data library.
- `src/lib/client/wallet.ts`: finds installed wallets (EIP-6963), signs in (SIWE for this host on Arc testnet, chain
  5042002), and sends the transactions the API prepares (cosign, cancel, agent setup) from the person's own wallet,
  switching it to Arc first and waiting for the receipt. Nothing holds a key.
- `src/app/(app)/cosign.tsx`: the signed-in app. It loads `/me`, picks the workspace (remembered), loads its detail,
  and opens one live stream per page (`/workspaces/:ws/activity/stream`). Each live event refreshes what it touched
  (`activity`, `proposal.drafted`, `team.message`) and tells the screens (`useLive`). Signed out → `/sign-in`. Loading,
  error and "not in a workspace yet" states use the library components; a failed refresh keeps what's on screen.

## Screens

- **Chat.** Agents you can use, with their saved orb colour and what they're working on. The conversation comes from
  the saved thread: your turns, what the agent did (one line per tool call, shadcn Trace), its words (streamed in as
  Grok writes them), and cards:
  a red card for a refused payment, an Approval Row for a purchase over the ask-a-person line (Approve OKs it and
  tells the agent to go ahead), for a treasury payment it drafted (Approve cosigns from your wallet, Deny cancels it
  onchain), and for a funding request (Approve opens Circle's onramp for the treasury in a new tab). A message
  streams the turn live, then the saved thread replaces the live copy. The @ list is the team (`/team`): other agents,
  Grok Bot and people. "@Grok Bot …" starts a background job for this agent (`POST /agents/:id/tasks`, on its Grok Bot
  routine or our own loop). Jobs and team @mentions show in the conversation at the time they happened; a job on Grok
  Bot is Grok Bot's turn (its icon, Background). New agent, delete agent and invite go to the API.
- **Voice.** Talk (shown only for agents with voice set up) opens a voice session and starts it in ElevenLabs
  (`@elevenlabs/react`). The call view (picked from `/mockups/v2/captions` and `/mockups/v2/call`): the orb, what you
  said, the step line (open while the agent works), then its words large, revealed as they are spoken (ElevenLabs sends
  each audio chunk with the time of every character; the text as written stands in before the audio). A payment drafted
  by voice opens the chat's approval row in the call. The call's handlers are passed to `startSession`, so they belong to
  the session (a page that suspends at the start can't drop them). The spoken turns land in the thread, tagged Voice.
- **Orbs.** Every agent orb moves (the ElevenLabs Orb inside Pesto's disc). A page shares at most 12 live canvases among
  the orbs on screen; each orb's canvas has its own Suspense boundary, so one loading never hides the page.
- **Permissions.** People: members and their roles; the two switches change the role (Approver, Agent user, Viewer),
  locked for All access and for people you may not manage. Agents: real spending charts and quota tiles
  (`/agents/:id/spend`), the settings accordion saves through `PATCH /agents/:id`, and the server's refusal shows on
  the sheet or card. When the treasury contract doesn't match an agent's settings, an approver signs the missing
  transactions from there. Treasury: balance and its 30-day history, approvers, where money went this week, onchain
  activity read from Arc, the ledger (open proposals approved or denied in your wallet) and every wallet.
- **Rooms** (⋮ → Delete room) are still the board's sample (the rooms and their messages live in the browser, kept apart per workspace),
  but who is in them is real: a room's agents are your agents and its people are the workspace's members (a room saved
  with the board's sample names keeps whoever has that name here). Asking in one is real too: an agent named with @ is your real agent of that name, answering in that room's own thread with you
  (not in your one-to-one chat; its memory and files are shared, and it is told which room it is in), and the room shows its steps and words as they stream in. "@Grok Bot …" in a room
  starts a real background job for the agent it names (or the room's first agent) and follows it until it reports.
  The answers are kept in the browser with the room.

## Browser tests

`pnpm test:browser` (Playwright 1.64.1) runs against the running dev server in the system's Google Chrome with a clean
profile, one spec per part:

| Spec | Proves |
|---|---|
| `01-foundation` | sign-in through the page, workspace and account, the live stream, sign out |
| `02-chat` | a real turn streams its steps; a refused payment's card; @Grok Bot starts a background job |
| `03-approvals` | a purchase over the line is OK'd and used; a draft is cosigned onchain; another is cancelled |
| `04-permissions` | invite and change a role; save a limit; a refused limit; add and remove a seller |
| `05-treasury` | balance, approvers, activity, wallets; an open proposal approved from the ledger |
| `06-voice` | a real ElevenLabs call; the spoken question becomes a Voice turn answered by the agent |
| `07-grokbot-onramp` | a job on a (stand-in) Grok Bot routine is Grok Bot's turn; a team mention; a funding request opens Circle's sandbox onramp |
| `08-room` | an agent named in a room answers for real with its words streamed; @Grok Bot in a room starts a real job |
| `10-grokbot-watch` | a payment executes; Grok Bot gets a job by itself to check it; the chat shows the onchain line and Grok Bot's answer |
| `qa-demo` | opt-in (`QA=1`, `QA_DIR`): the demo beat by beat with screenshots, permissions changed and their effect tested |
| `09-voice-tools` | opt-in (`VOICE_TOOLS=1`, a real call): five recorded questions in one call (none, balances, proposals, payees, a draft); each uses its tool, the draft opens its approval row, every turn is timed |

`tests/browser/voice-eval.ts` (not a spec; `pnpm exec tsx --env-file=.env.local tests/browser/voice-eval.ts`) sends the whole
voice test set (32 prompts: reads, drafts, petty cash, sends, paid APIs, App Kit, onramp, team, Grok Bot, safety,
memory, a pause) to the voice brain as ElevenLabs would, grades each turn and times it (report in
`node_modules/.cosign-tmp/voice-eval.md`). No ElevenLabs call.

- The wallet is a throwaway key the test injects as an EIP-1193 provider (`tests/browser/wallet.ts`); there is no test
  login or backdoor in the app.
- `global-setup.ts` makes one throwaway company onchain (about 0.5 testnet USDC from the demo CFO) and reuses it while
  it answers (`FRESH=1` makes a new one). It keeps a little USDC in the test agent's wallet (Arc's gas is USDC).
- Voice gives the test agent its own ElevenLabs agent ("Cosign: Clerk (browser test)"). Chrome launched from a
  terminal on macOS can't open a microphone, even a fake one (the system prompt has nowhere to show), so the voice spec
  plays a recorded question (`say`) into the page as its microphone. Each run is one short ElevenLabs call.
- `tests/browser/peek.ts` prints the test workspace's thread, proposals, approvals, tasks or funding requests.
- The onramp check only reads the new tab's address (`onramp-sandbox.arc.io`); nothing is typed into Circle's widget.

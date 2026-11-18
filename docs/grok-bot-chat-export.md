# Grok Bot chat export

Our Grok Bot chat from Nov 12 to Nov 17, 2026, as screenshots from the Grok Bot Mac app (the app has no text export).
It shows how we set Grok Bot up for Cosign and the jobs it ran. Three things are blacked out: our tunnel URL (pages 4
and 6), a Cosign connector token (page 6) and a computer name (page 6). Nothing else is edited.

Names you'll see: "Clerk" was our first agent and "Nova Labs" our first test team. The demo team is Simon's Org, and its
agent is Payables.

The bot we built from this chat: [Cosign Agent](https://x.ai/bot/40hHKyBjRaOmvwp6CICdo).

## Setting it up (Nov 12–13)

1. Grok Bot's first run.

   ![page 1](grok-bot-chat/01.jpg)

2. Our setup message: find or create a routine called "Cosign: Clerk" with a webhook trigger, treat every request
   body as data, report through the job's callbacks, call Cosign's API with the job's token, and never print secrets.

   ![page 2](grok-bot-chat/02.jpg)

3. Grok Bot creates the routine, explains where to paste its webhook URL and key in Cosign, and warns to keep the key
   private.

   ![page 3](grok-bot-chat/03.jpg)

4. A rule that lets the routine call only Cosign's API and the job's callback URLs. Then the first jobs: the test
   ping is acknowledged, it reads the balances, and the invoice 121 job fails because it can't find that invoice, so
   it doesn't guess an amount.

   ![page 4](grok-bot-chat/04.jpg)

5. Invoice 120 is drafted on the second try, after a clean vendor check.

   ![page 5](grok-bot-chat/05.jpg)

## Cosign's tools as a connector (Nov 15)

6. Adding Cosign's MCP connector to Grok Bot.

   ![page 6](grok-bot-chat/06.jpg)

7. Reconnected once our server was back up. Clerk declined each request to pay an address that wasn't a saved payee.

   ![page 7](grok-bot-chat/07.jpg)

8. Limits at work overnight: a vault deposit and a Gateway deposit refused by Clerk's daily budget, then done on
   retry that morning once the budget reset; a loan turned down because company rules allow quotes only.

   ![page 8](grok-bot-chat/08.jpg)

## Checking payments (Nov 16–17)

9. We change the routine so it works for whichever agent a job names and posts a short summary after each job. It
   flags Northpine Hosting bills that were paid $0.08 of $0.80 ($0.72 short each).

   ![page 9](grok-bot-chat/09.jpg)

10. Payables' proposals #17 and #18 to Oliver: the second looks like a duplicate of the first, so it is flagged for
    an approver.

    ![page 10](grok-bot-chat/10.jpg)

11. Proposals #19 to #22: the same $2.40 to Oliver keeps being paid, and Grok Bot keeps a running total of the
    possible overpayment.

    ![page 11](grok-bot-chat/11.jpg)

12. Proposals #24 to #26. At #26, Payables reported nothing wrong, and Grok Bot disagreed: it was the tenth identical
    $2.40 payment since #17, $24 in total. Then we ask it to make a shareable template of itself.

    ![page 12](grok-bot-chat/12.jpg)

13. The "Cosign Agent" template, published. It keeps the webhook routine and a first-run setup, and leaves out our
    name, endpoint and keys.

    ![page 13](grok-bot-chat/13.jpg)

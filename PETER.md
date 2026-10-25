# Peter: how things get done

The chat is a chat of three: **you**, **the model** (by its own name: `@qwen3` for `qwen3:8b`),
and **Peter**, [Tool Mac Agent](https://github.com/ainigh/tool-mac-tool-run-agent), who carries
out anything on the Mac and the web. The model has no tools to learn: Peter is a participant, not
a tool. It asks him the way you'd ask a colleague in a chat, in plain words, and he answers in
plain words, with the result, or with a few templates that would do it (blanks to fill, `{…}`; a
choice of one, `[a | b]`), which the model fills in and says back. The model never sees a tool
name, an argument, a request id or JSON, and never polls. Super Face never talks to Tool Mac Tool
Run itself: Peter does.

- **Every answer is addressed.** `@user …` is said aloud to you; `@peter …` goes to Peter. An
  answer may do both: "@user Let me check." (heard while Peter works), then "@peter …".
- **What's said to and by Peter is never read aloud**: a tone plays instead, two quick notes
  rising for a message to him, falling for his answer. The chat shows each, `@peter …` and his
  `@qwen3 …`.
- **Peter's answer goes to the model at once, as yours do**: as a message in the chat, from
  Peter. Even while you're talking: what you say goes when you've finished, and its answer to you
  is said at once.
- **Peter keeps no conversation**: each message to him is whole in itself (no "yes", no "the
  second one"). When his own model read the words into one of his templates, he says how ("Taken
  as: …"), so the model can say it that way next time.
- **A long job doesn't hold up the conversation.** A script or flow (which waits for someone to
  click Run on the Mac) is "asked for", and the turn ends. When it's over, Peter calls Super Face
  back at the address it gave (`POST /api/peter`), and his news comes in like a message: "Meanwhile:
  the nightly backup finished (it worked)". If Super Face wasn't running then, the news comes first
  in his next answer instead.
- **Later is Peter's too**: "@peter remind me in 20 minutes: tell the user to call Sam", "@peter
  every weekday at 8am, search the web for the traffic on I-35". When it's due, he calls back the
  same way, and the model does what it says.
- **Cancel** still works without the model: the Stop button, a message's Cancel, or saying
  "cancel" takes a run back off the Mac (or stops it).

## An example: the Walmart near me

Sunday 25 October 2026, 9:40 pm. MEMORY has where the user lives, and Super Face gives it to the
model with every request (read through Peter):

```
What MEMORY has on the user themselves:
- the user @pref lives in Austin, TX 78745
```

### 1. Is it open, and till when tomorrow?

> **You** (heard): `@qwen3` is the walmart near me still open? and when do they close tomorrow? let me see it

> **qwen3**: `@user` Let me check.
> `@peter` search the web for Walmart Supercenter hours Austin TX 78745

"Let me check." is said; the message to Peter isn't: a rising tone plays.

> **Peter** (falling tone, not said): `@qwen3`
> ```
> The web has these for "Walmart Supercenter hours Austin TX 78745":
> 1. Walmart Supercenter in Austin, TX | 710 E Ben White Blvd
>    https://www.walmart.com/store/1234-austin-tx
>    Open today until 11pm. Store hours 6am–11pm. Pharmacy, pickup and delivery…
> 2. Walmart Supercenter in Austin, TX | 5017 W Hwy 290
>    https://www.walmart.com/store/5678-austin-tx
>    …
> ```

The first is the nearest one (78745). The model checks the hours on the store's own page, since a
search snippet can be old:

> **qwen3**:
> ```
> @peter
> Find words on a web page
> - address: https://www.walmart.com/store/1234-austin-tx
> - words: hours
> ```

> **Peter**: `@qwen3`
> ```
> The lines of https://www.walmart.com/store/1234-austin-tx with "hours":
> Store hours: Open today until 11pm
> Mon–Sun: 6am – 11pm
> Pharmacy hours: Mon–Fri 9am – 8pm, Sat 9am – 6pm, Sun closed
> ```

It's 9:40 pm on a Sunday, and the store closes at 11: it's open. Tomorrow is Monday: 6 am to 11
pm. The user said "let me see it", so:

> **qwen3**: `@user` Yes, the one on East Ben White is open until 11 tonight, and tomorrow it's open
> from 6 in the morning to 11 at night. I'll put its page up for you.
> `@peter` open https://www.walmart.com/store/1234-austin-tx in Chrome

> **Peter**: `@qwen3 Opened in your own Chrome window, side by side with the person's. Walmart Supercenter in Austin, TX | 710 E Ben White Blvd…`

> **qwen3**: `@user` There it is, on the right.

### 2. "From now on, when I say walmart…"

> **You**: `@qwen3` from now on whenever I say walmart just tell me yes if they're open and no if they're closed

That's a standing instruction, so it goes in the user's standing instructions (the note **Super
Face instructions**, which the model is given with every request):

> **qwen3**: `@user` Got it.
> ```
> @peter
> Add to a note
> - name: Super Face instructions
> - text: - When the user says just "walmart": ask Peter for the lines with "hours" on https://www.walmart.com/store/1234-austin-tx (holidays change them), and answer with one word: "Yes." if that Walmart (710 E Ben White Blvd) is open right now, "No." if it's closed. If the page can't be read, go by its usual hours, 6am to 11pm every day.
> ```

> **Peter**: `@qwen3 Added that to the end of the note Super Face instructions.`

> **qwen3**: `@user` Done. Say walmart any time and I'll tell you yes or no.

What it wrote has everything the next time needs, because the next time it will have only that
line, not this conversation.

### 3. Next time

Tuesday, 11:20 pm:

> **You**: `@qwen3` walmart
>
> **qwen3**: `@peter` … the lines with "hours" … (nothing said yet; the soft busy tone plays)
>
> **Peter**: `@qwen3 … Store hours: Closed now. Opens tomorrow at 6am …`
>
> **qwen3**: `@user` No.

## When it's a run

> **You**: `@qwen3` back up my documents
>
> **qwen3**: `@user` I'll ask for it.
> `@peter` run the nightly backup
>
> **Peter**: `@qwen3 Asked for the nightly backup. I'll tell you how it goes.`
>
> **qwen3**: `@user` It's asked for. I'll tell you when it's done.

(A run waits for someone to click Run on the Mac. Super Face says it itself when the card has
waited a while: "It's waiting for you to click Run on your Mac.") The turn is over; you can talk
about anything else. Minutes later, Peter calls back, and this comes in as a message from him:

> **Peter**: `@qwen3 Meanwhile: The nightly backup finished (it worked). It printed: backed up 1,204 files`
>
> **qwen3**: `@user` Your backup's done, and it worked.

## When it's for later

> **You**: `@qwen3` remind me to call Sam in 20 minutes
>
> **qwen3**: `@peter` remind me in 20 minutes: tell the user it's time to call Sam.
>
> **Peter**: `@qwen3 Set for today at 21:40 (in 20 minutes): a reminder: tell the user it's time to call Sam. Its number is 3. I'll tell you then.`
>
> **qwen3**: `@user` Sure, I'll remind you at 9:40.

Twenty minutes later:

> **Peter**: `@qwen3 Meanwhile: Reminder (Scheduled today at 21:20, number 3): tell the user it's time to call Sam.`
>
> **qwen3**: `@user` It's time to call Sam!

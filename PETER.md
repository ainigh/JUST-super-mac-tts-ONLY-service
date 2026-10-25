# Peter: how things get done

The chat is a chat of three: **you**, **the model** (by its own name: `@qwen3` for `qwen3:8b`),
and **Peter**, [Tool Mac Agent](https://github.com/ainigh/tool-mac-tool-run-agent), who carries
out anything on the Mac and the web. The model has no tools to learn: Peter is a participant, not
a tool. It asks him the way you'd ask a colleague, in plain words, and he answers in plain words,
with what he did and what came of it. The model never sees a tool name, an argument, a template,
a request id or JSON, and never polls. Super Face never talks to Tool Mac Tool Run itself: Peter
does.

Super Face has the context: who you are, what you're talking about, what "done" means for you.
Peter knows how to do things, but knows nothing of the conversation. So the translating is all
his: his own model reads each message and works out which of his tools do it. Why it's built this
way: [Peter's DECISIONS.md](https://github.com/ainigh/tool-mac-tool-run-agent/blob/main/DECISIONS.md).

- **Every answer is addressed.** `@user …` is said aloud to you; `@peter …` goes to Peter. An
  answer may do both: "@user Let me check." (heard while Peter works), then "@peter …".
- **What's said to and by Peter is never read aloud**: a tone plays instead, two quick notes
  rising for a message to him, falling for his answer. The chat shows each, `@peter …` and his
  `@qwen3 …`.
- **Peter's answer goes to the model at once, as yours do**: as a message in the chat, from
  Peter. Even while you're talking: what you say goes when you've finished, and its answer to you
  is said at once.
- **Peter keeps no conversation**: each message to him is all he has, so it's the whole request,
  with every detail (the place, the address, the time). When he needs something, or can't do it,
  he says so, and how to ask, and ends with *I don't keep our conversation: send the whole request
  again.* The model then asks him again, whole, or asks you, if only you know.
- **"How would I ask you to …?"** finds out what he can do without his doing anything.
- **A long job doesn't hold up the conversation.** A script or flow (which waits for someone to
  click Run on the Mac) is "asked for", and the turn ends. When it's over, Peter calls Super Face
  back at the address it gave (`POST /api/peter`), and his news comes in like a message: "Meanwhile:
  the nightly backup finished (it worked)". If Super Face wasn't running then, the news comes first
  in his next answer instead.
- **Later is Peter's too**: "@peter remind me in 20 minutes to tell the user to call Sam", "@peter
  every weekday at 8am, search the web for the traffic on I-35". When it's due, he calls back the
  same way, and the model does what it says.
- **What it learns, Peter keeps.** "From now on…" goes to Super Face's standing instructions,
  something about you to MEMORY: the model asks Peter, word for word, and he writes it. Super Face
  reads its instructions and playbook straight from its own space in
  [Storage Spaces](https://github.com/ainigh/tool-mac-tool-run-storage-spaces) (SUPER/PROMPT,
  SUPER/MEMORY) at the start of every request.
- **Cancel** still works without the model: the Stop button, a message's Cancel, or saying
  "cancel" takes a run back off the Mac (or stops it).

## An example: the Walmart near me

Sunday 25 October 2026, 9:40 pm.

### 1. Is it open, and till when tomorrow?

> **You** (heard): `@qwen3` is the walmart on ben white still open? and when do they close tomorrow? let me see it

> **qwen3**: `@user` Let me check.
> `@peter` Is the Walmart on East Ben White Blvd in Austin, TX open right now, what are its hours tomorrow (Monday), and open its page in Chrome.

"Let me check." is said; the message to Peter isn't: a rising tone plays. Peter's model searches
the web, reads the store's own page (a search snippet can be old) and opens it:

> **Peter** (falling tone, not said): `@qwen3 Yes: the Walmart Supercenter at 710 E Ben White Blvd is open until 11pm tonight, and tomorrow from 6am to 11pm. Its page (walmart.com/store/1234-austin-tx) is open in your own Chrome window, side by side with the person's.`

> **qwen3**: `@user` Yes, it's open until 11 tonight, and tomorrow from 6 in the morning to 11 at
> night. Its page is up on the right.

### 2. "From now on, when I say walmart…"

> **You**: `@qwen3` from now on whenever I say walmart just tell me yes if they're open and no if they're closed

That's a standing instruction, so it goes in Super Face's instructions, which the model is given
with every request. It has everything the next time needs, because the next time the model will
have only that line, not this conversation:

> **qwen3**: `@user` Got it.
> `@peter` Add to Super Face's instructions, word for word: "When the user says just walmart: ask Peter whether the Walmart Supercenter at 710 E Ben White Blvd, Austin TX (walmart.com/store/1234-austin-tx) is open right now, and answer with one word: Yes or No."

> **Peter**: `@qwen3 Added it to the end of Super Face's instructions.`

> **qwen3**: `@user` Done. Say walmart any time and I'll tell you yes or no.

### 3. Next time

Tuesday, 11:20 pm:

> **You**: `@qwen3` walmart
>
> **qwen3**: `@peter` Is the Walmart Supercenter at 710 E Ben White Blvd, Austin TX open right now? (nothing said yet; the soft busy tone plays)
>
> **Peter**: `@qwen3 No: it closed at 11pm, and opens tomorrow at 6am.`
>
> **qwen3**: `@user` No.

## When Peter needs something

> **You**: `@qwen3` open that recipe page from earlier

> **qwen3**: `@peter` Open the recipe page in Chrome.
>
> **Peter**: `@qwen3 Which page? Ask again with its address: open https://… in Chrome. I don't keep our conversation: send the whole request again.`

The model has the address from earlier in the chat, so it asks again, whole:

> **qwen3**: `@peter` Open https://cooking.example/shakshuka in Chrome.
>
> **Peter**: `@qwen3 Opened https://cooking.example/shakshuka in your own Chrome window, side by side with the person's.`
>
> **qwen3**: `@user` There it is.

Had it not known, it would have asked you.

## When it's a run

> **You**: `@qwen3` back up my documents
>
> **qwen3**: `@user` I'll ask for it.
> `@peter` Run the nightly backup.
>
> **Peter**: `@qwen3 Asked for the nightly backup. You'll be told how it went the moment it's over.`
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
> **qwen3**: `@peter` Remind me in 20 minutes to tell the user it's time to call Sam.
>
> **Peter**: `@qwen3 Set for today at 21:40 (in 20 minutes): a reminder: tell the user it's time to call Sam. Its number is 3. I'll tell you then.`
>
> **qwen3**: `@user` Sure, I'll remind you at 9:40.

Twenty minutes later:

> **Peter**: `@qwen3 Meanwhile: Reminder (Scheduled today at 21:20, number 3): tell the user it's time to call Sam.`
>
> **qwen3**: `@user` It's time to call Sam!

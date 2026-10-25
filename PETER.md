# Peter: how the model gets things done

The model has no tools to learn. When something needs doing on the Mac or the web, it asks
**Peter**, the way you'd ask a colleague in a chat: it ends its answer with a line that starts
`@peter`, and says what it wants in plain words. Peter is [Tool Mac Tool Run](https://github.com/ainigh/tool-mac-tool-run)'s
`POST /api/say`: he answers in plain words too, with the result, or with a few templates that
would do it (blanks to fill, `{…}`; a choice of one, `[a | b]`), which the model fills in and says
back. The model never sees a tool name, an argument, a request id or JSON, and never polls.

- **What the model writes after `@peter` is never said aloud**: the words before it are (so
  "Let me check" is heard while Peter works). The chat shows each exchange as a card.
- **Peter's answers are for the model only**: the user hears what matters from the model, in its
  own words.
- **A long job doesn't hold up the conversation.** A script or flow (which waits for someone to
  click Run on the Mac) is "asked for", and the turn ends. When it's over, Tool Mac Tool Run calls
  Super Face back at the address it gave (`POST /api/peter`), and Peter's news comes in like a
  message: "Meanwhile: the nightly backup finished (it worked)". If Super Face wasn't running
  then, the news comes first in Peter's next answer instead.
- **The templates that fit come with the request**, so the model can usually fill one in at once
  instead of asking Peter what he can do.
- **Later is `@clock`**: the schedule, the one thing kept in Super Face itself, is asked the same
  way.
- **Cancel** still works without the model: the Stop button, a card's Cancel, or saying "cancel"
  takes a run back off the Mac (or stops it).

## An example: the Walmart near me

Sunday 25 October 2026, 9:40 pm. MEMORY has where the user lives, and Super Face gives it to the
model with every request, with the templates of Peter's that fit what was just said:

```
What MEMORY has on the user themselves:
| the user @pref lives in Austin, TX 78745

Peter's templates that fit what was just said:
- search the web for {what to look for}
- read the page at {a web address}
- open {a web address} in Chrome
```

### 1. Is it open, and till when tomorrow?

> **User** (heard): is the walmart near me still open? and when do they close tomorrow? let me see it

> **Model**: Let me check.
> `@peter search the web for Walmart Supercenter hours Austin TX 78745`

"Let me check." is said; the `@peter` line isn't. The chat shows a card: *To Peter: search the
web for Walmart Supercenter hours Austin TX 78745*.

> **Peter** (to the model only):
> ```
> The web has these for "Walmart Supercenter hours Austin TX 78745":
> 1. Walmart Supercenter in Austin, TX | 710 E Ben White Blvd
>    https://www.walmart.com/store/1234-austin-tx
>    Open today until 11pm. Store hours 6am–11pm. Pharmacy, pickup and delivery…
> 2. Walmart Supercenter in Austin, TX | 5017 W Hwy 290
>    https://www.walmart.com/store/5678-austin-tx
>    …
>
> You can also say:
> - read the page at {a web address}
> - open {a web address} in Chrome
> ```

The first is the nearest one (78745). The model checks the hours on the store's own page, since a
search snippet can be old:

> **Model**:
> ```
> @peter
> Find words on a web page
> - address: https://www.walmart.com/store/1234-austin-tx
> - words: hours
> ```

> **Peter**:
> ```
> The lines of https://www.walmart.com/store/1234-austin-tx with "hours":
> Store hours: Open today until 11pm
> Mon–Sun: 6am – 11pm
> Pharmacy hours: Mon–Fri 9am – 8pm, Sat 9am – 6pm, Sun closed
> ```

It's 9:40 pm on a Sunday, and the store closes at 11: it's open. Tomorrow is Monday: 6 am to 11
pm. The user said "let me see it", so:

> **Model**: Yes, the one on East Ben White is open until 11 tonight, and tomorrow it's open from
> 6 in the morning to 11 at night. I'll put its page up for you.
> `@peter open https://www.walmart.com/store/1234-austin-tx in Chrome`

> **Peter**: `Opened in Chrome. Walmart Supercenter in Austin, TX | 710 E Ben White Blvd…`

> **Model**: There it is.

### 2. "From now on, when I say walmart…"

> **User**: from now on whenever I say walmart just tell me yes if they're open and no if they're closed

That's a standing instruction, so it goes in the user's standing instructions (the library note
**Super Face instructions**, which the model is given with every request). The model doesn't know
the exact template, so it says what it wants:

> **Model**: Got it.
> `@peter add a line to my note Super Face instructions`

> **Peter**:
> ```
> These can do that:
> 1. Add to a note
>      - name: {its name}
>      - text: {what to add at its end}
> 2. Write a note
>      - name: {its name}
>      - text: {what it says (it replaces what was there)}
> 3. Read a note
>      read the note {its name}
> Fill one in and say it back.
> ```

> **Model**:
> ```
> @peter
> Add to a note
> - name: Super Face instructions
> - text: - When the user says just "walmart": ask Peter for the lines with "hours" on https://www.walmart.com/store/1234-austin-tx (holidays change them), and answer with one word: "Yes." if that Walmart (710 E Ben White Blvd) is open right now, "No." if it's closed. If the page can't be read, go by its usual hours, 6am to 11pm every day.
> ```

> **Peter**: `Added that to the end of the note Super Face instructions.`

> **Model**: Done. Say walmart any time and I'll tell you yes or no.

What it wrote has everything the next time needs (which store, which page, what to look for, what
to say, and what to do if the page doesn't answer), because the next time it will have only that
line, not this conversation.

### 3. Next time

Tuesday, 11:20 pm. With this request the model is given, as with every request:

```
The user's standing instructions (follow them):
- When the user says just "walmart": ask Peter for the lines with "hours" on https://www.walmart.com/store/1234-austin-tx …
```

> **User**: walmart

> **Model** (no words before it, so nothing is said yet; the soft busy tone plays):
> ```
> @peter
> Find words on a web page
> - address: https://www.walmart.com/store/1234-austin-tx
> - words: hours
> ```

> **Peter**: `… Store hours: Closed now. Opens tomorrow at 6am …`

> **Model**: No.

And on Wednesday at 8:05 am:

> **User**: walmart
>
> **Model**: `@peter …` (the same) → **Peter**: `… Store hours: Open today until 11pm …`
>
> **Model**: Yes.

### What the conversation keeps

Once a request is answered, Peter's lists of templates are folded to a line ("Peter offered: Add
to a note, Write a note, Read a note") and long answers are cut short, so what the model reads
next time is what was asked and what came of it, not the back and forth.

## When it's a run

> **User**: back up my documents
>
> **Model**: I'll ask for it.
> `@peter run the nightly backup`
>
> **Peter**: `Asked for the nightly backup. I'll tell you how it goes.`
>
> **Model**: It's asked for. I'll tell you when it's done.

(A run waits for someone to click Run on the Mac. Peter doesn't trouble the model with that, so
Super Face says it itself when the card has waited a while: "It's waiting for you to click Run on
your Mac.") The turn is over; the user can talk about anything else. Minutes later, Tool Mac Tool Run calls
Super Face back, and this comes in as a message from Peter:

> **Peter**: `Meanwhile: The nightly backup finished (it worked). Say "show me the nightly backup" to see what it printed.`
>
> **Model**: Your backup's done, and it worked.

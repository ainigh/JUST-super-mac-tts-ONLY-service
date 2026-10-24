#!/usr/bin/env python3
# Your notes library: add, list, search, read, change and remove notes (plain text files you can open anywhere)
#
# Input: What to do: add, list, search, read, append, replace, rename, star, unstar, remove, restore, where
# Input (optional): The note (its title, or its number from list), or the words to search for
# Input (optional): The text (to add, append or replace with), or the new title
# Input text (optional): The text, when it's long (instead of the third argument)
#
#   library.py add "Shopping" "eggs, milk"      a new note called Shopping
#   library.py list                             every note, newest first, with its number
#   library.py list starred                     only the starred ones
#   library.py search budget march              notes with all those words
#   library.py read Shopping                    a note in full (or: read 3)
#   library.py append Shopping "bread"          adds a line to it
#   library.py replace Shopping "just coffee"   its text, all of it, replaced
#   library.py rename Shopping "Groceries"
#   library.py star Groceries | unstar Groceries
#   library.py remove Groceries                 to the library's trash (restore Groceries brings it back)
#   library.py where                            the folder they're kept in
# Each note is a text file in ~/Documents/Library (LIBRARY_DIR to keep them elsewhere).
import datetime
import os
import re
import sys

ROOT = os.path.expanduser(os.environ.get("LIBRARY_DIR") or "~/Documents/Library")
TRASH = os.path.join(ROOT, ".trash")
HELP = "What to do: add, list, search, read, append, replace, rename, star, unstar, remove, restore or where."


def now():
    return datetime.datetime.now().replace(microsecond=0).isoformat(sep=" ")


def slug(title):
    s = re.sub(r"[^\w\s-]", "", title, flags=re.UNICODE).strip().lower()
    return re.sub(r"[\s_]+", "-", s)[:60] or "note"


def parse(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    meta, text = {}, raw
    if raw.startswith("---\n"):
        head, sep, rest = raw[4:].partition("\n---\n")
        if sep:
            for line in head.splitlines():
                key, _, value = line.partition(":")
                meta[key.strip()] = value.strip()
            text = rest
    stamp = datetime.datetime.fromtimestamp(os.path.getmtime(path)).replace(microsecond=0).isoformat(sep=" ")
    return {
        "path": path,
        "title": meta.get("title") or os.path.splitext(os.path.basename(path))[0],
        "created": meta.get("created") or stamp,
        "changed": meta.get("changed") or stamp,
        "starred": meta.get("starred") == "yes",
        "text": text.strip("\n"),
    }


def save(note):
    os.makedirs(os.path.dirname(note["path"]), exist_ok=True)
    head = f"---\ntitle: {note['title']}\ncreated: {note['created']}\nchanged: {note['changed']}\nstarred: {'yes' if note['starred'] else 'no'}\n---\n"
    tmp = note["path"] + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(head + note["text"].rstrip("\n") + "\n")
    os.replace(tmp, note["path"])


def notes(folder=ROOT):
    if not os.path.isdir(folder):
        return []
    found = [parse(os.path.join(folder, n)) for n in os.listdir(folder) if n.endswith(".md")]
    return sorted(found, key=lambda n: n["changed"], reverse=True)


def find(which, folder=ROOT):
    """The note a title, a part of one, or a number from list means."""
    all_notes = notes(folder)
    if not which:
        sys.exit("Say which note: its title, or its number from list.")
    if which.isdigit() and 1 <= int(which) <= len(all_notes):
        return all_notes[int(which) - 1]
    key = which.strip().lower()
    exact = [n for n in all_notes if n["title"].lower() == key]
    if exact:
        return exact[0]
    near = [n for n in all_notes if key in n["title"].lower()]
    if len(near) == 1:
        return near[0]
    if len(near) > 1:
        sys.exit(f"More than one note has \"{which}\" in its title: " + "; ".join(n["title"] for n in near[:10]) + ". Say which.")
    sys.exit(f"There's no note called \"{which}\"." + (" The notes: " + "; ".join(n["title"] for n in all_notes[:20]) + "." if all_notes else " The library is empty."))


def line(i, n):
    first = " ".join(n["text"].split())[:80]
    star = " ★" if n["starred"] else ""
    return f"{i}. {n['title']}{star} ({n['changed'][:16]}){': ' + first if first else ''}"


def free_path(title, folder=ROOT):
    base = os.path.join(folder, slug(title))
    path, k = base + ".md", 2
    while os.path.exists(path):
        path, k = f"{base}-{k}.md", k + 1
    return path


def text_from(args, start):
    if len(args) > start:
        return " ".join(args[start:])
    if not sys.stdin.isatty():
        return sys.stdin.read().strip("\n")
    return ""


def main(args):
    if not args:
        sys.exit(HELP)
    what, rest = args[0].lower(), args[1:]
    if what in ("add", "new", "note", "save"):
        if not rest:
            sys.exit("Give the note a title (and its text).")
        title = rest[0].strip()
        text = text_from(rest, 1)
        if any(n["title"].lower() == title.lower() for n in notes()):
            sys.exit(f"There's already a note called \"{title}\": append to it, replace it, or pick another title.")
        n = {"path": free_path(title), "title": title, "created": now(), "changed": now(), "starred": False, "text": text}
        save(n)
        print(f"Added \"{title}\" to the library ({len(text.split())} words).")
    elif what in ("list", "ls", "all"):
        all_notes = notes()
        shown = [n for n in all_notes if n["starred"]] if rest and rest[0].lower() in ("starred", "star", "stars") else all_notes
        if not shown:
            print("The library is empty." if not all_notes else "No starred notes.")
        for i, n in enumerate(all_notes, 1):
            if n in shown:
                print(line(i, n))
    elif what in ("search", "find"):
        words = [w.lower() for w in rest]
        if not words:
            sys.exit("Say what to search for.")
        hits = [(i, n) for i, n in enumerate(notes(), 1) if all(w in (n["title"] + " " + n["text"]).lower() for w in words)]
        if not hits:
            print(f"No note has {' and '.join(repr(w) for w in words)}.")
        for i, n in hits:
            print(line(i, n))
    elif what in ("read", "show", "open", "get"):
        n = find(" ".join(rest))
        print(f"{n['title']}{' ★' if n['starred'] else ''} (written {n['created'][:16]}, changed {n['changed'][:16]})\n")
        print(n["text"] or "(empty)")
    elif what in ("append", "add-to", "addto"):
        n = find(rest[0] if rest else "")
        text = text_from(rest, 1)
        if not text:
            sys.exit("Give the text to add.")
        n["text"] = (n["text"] + "\n" if n["text"] else "") + text
        n["changed"] = now()
        save(n)
        print(f"Added to \"{n['title']}\".")
    elif what in ("replace", "set", "edit", "change"):
        n = find(rest[0] if rest else "")
        text = text_from(rest, 1)
        if not text:
            sys.exit("Give the new text (to empty it, remove it instead).")
        n["text"] = text
        n["changed"] = now()
        save(n)
        print(f"Replaced the text of \"{n['title']}\".")
    elif what == "rename":
        if len(rest) < 2:
            sys.exit("Say which note, and its new title.")
        n = find(rest[0])
        old, n["title"], n["changed"] = n["title"], " ".join(rest[1:]).strip(), now()
        save(n)
        print(f"Renamed \"{old}\" to \"{n['title']}\".")
    elif what in ("star", "unstar"):
        n = find(" ".join(rest))
        n["starred"] = what == "star"
        save(n)
        print(f"{'Starred' if n['starred'] else 'Unstarred'} \"{n['title']}\".")
    elif what in ("remove", "delete", "trash"):
        n = find(" ".join(rest))
        os.makedirs(TRASH, exist_ok=True)
        os.replace(n["path"], free_path(n["title"], TRASH))
        print(f"Moved \"{n['title']}\" to the library's trash (restore \"{n['title']}\" brings it back).")
    elif what in ("restore", "undelete"):
        n = find(" ".join(rest), TRASH)
        target = free_path(n["title"])
        os.replace(n["path"], target)
        print(f"Restored \"{n['title']}\".")
    elif what in ("where", "folder"):
        print(ROOT)
    else:
        sys.exit(f"I don't know \"{what}\". {HELP}")


main(sys.argv[1:])

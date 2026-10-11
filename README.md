# Mobile-SR

**Spaced repetition for Obsidian that works on your phone, with three games to make the practice stick.**

Write flashcards in plain Markdown, review them with the FSRS scheduler on desktop or mobile, and when you are tired of flipping cards, shoot asteroids, race the clock or save the hangman using the same decks.

## Play your decks

Every game has its own menu where you pick a deck, and each one keeps your records. The games are practice only: they never change your review schedule, so you can play as much as you like without disturbing FSRS.

### 🚀 Blast

A question appears at the top and asteroids carrying answers float around the space above your ship. Shoot the right one.

- You have 60 seconds per level to reach the target: 50 points on level 1, 100 on level 2, and so on.
- The first hit is worth 5 points, and every hit in a row raises the multiplier.
- A wrong shot costs 2 points and resets your streak.
- Higher levels bring more asteroids that move faster.
- Your high score and best streak are saved.

### 🧩 Match

Six random cards from your deck are split into twelve tiles. Pair each question with its answer and clear the board as fast as you can.

- The clock counts up and a wrong match adds one second.
- Your best time is saved separately for every deck.

### 🪢 Hangman

One side of a card is the clue, the other is hidden. Guess it letter by letter before the figure is complete.

- Six wrong letters end the run. Your score is how many cards you solve in a row, saved per deck.
- Stuck? Reveal up to half of the letters one at a time, or skip the card without breaking your streak.
- Works with Hebrew and English, on the on-screen keyboard or a physical one. Hebrew nikud is shown but does not need to be guessed.

Open the games from the **Games** section at the bottom of the dashboard, or with the commands **Play Blast Game**, **Play Match Game** and **Play Hangman Game**.

## Features

- **Built for mobile.** Everything works on Android and iOS: reviews, the dashboard and all three games.
- **FSRS scheduling.** Cards come back just before you would forget them. The classic SM-2 algorithm is available too.
- **Plain Markdown cards.** A deck is just a note. No special editor and no lock-in.
- **Syncs like a note.** Your progress is stored in a Markdown file inside the vault, so any sync that handles your notes also carries your review schedule between devices.
- **Dashboard.** See every deck with its due cards, start a session for one deck, and search a table of everything you have reviewed with its next due time.
- **Reversed cards.** One card can be studied in both directions.
- **Hints.** Mark a deck as a hint deck and each card gets a **Show hint** button.
- **Edit while reviewing.** Fix a typo in a card without leaving the session.
- **Interval previews.** The rating buttons can show when the card will return (for example 10m, 3d, 2mo).
- **Deck cleanup.** One command fixes spacing and removes duplicate cards from a note.
- **Self-cleaning data.** Cards you delete from your notes are removed from the saved schedule automatically.
- **Right-to-left friendly.** Decks and cards in Hebrew display correctly.

## Installation

Simply get it from obsidian community , but here are some alternatives:

### With BRAT (recommended, includes updates)

1. Install the **BRAT** plugin from **Settings → Community plugins → Browse** and enable it.
2. Open **Settings → BRAT → Add beta plugin**.
3. Paste `https://github.com/kfirgumay2005-hash/Mobile-SR` and select **Add plugin**.
4. Enable **Mobile-SR** in **Settings → Community plugins**.

This works the same way on mobile.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/kfirgumay2005-hash/Mobile-SR/releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/mobilesr/` (create the folder if needed).
3. Reload Obsidian and enable **Mobile-SR** in **Settings → Community plugins**.

## Writing cards

A deck is a note that contains the `#flashcards` tag. The note's name is the deck's name. Each card sits between two lines that contain only a hyphen, with a line containing only `?` between the question and the answer:

```markdown
#flashcards

- What is the capital of France?
  ?
  Paris
- enigma
  ?
  A mystery; something that cannot be deciphered.
-
```

- **The hyphen lines matter.** Every card needs a `-` line before it and after it. Neighbouring cards share the hyphen between them.
- **Reversed cards:** use `??` instead of `?` to study the card in both directions.
- **Hints:** add the `#hint` tag to the note as well. The first line of each card is then the question, and any lines between it and the `?` are hidden behind a **Show hint** button.

### Importing a deck

To bring in a deck from somewhere else (for example Quizlet), paste it into an AI assistant and ask it to put a `?` line between each term and its meaning, add the hyphen lines, and return plain text. Paste the result into a note and run **Fix Cards Spacing and Remove Duplicates** to tidy it up.

## Using the plugin

Select the plugin's icon in the ribbon, or run **Open Spaced Repetition Dashboard**.

- **Decks:** each deck shows how many cards are due and has its own **Start** button for a session with that deck only.
- **Reviewed flashcards status:** a searchable table of the cards you have studied, with the time left until the next review and the current interval.
- **Games:** Blast, Match and Hangman.

## Settings

| Setting                              | What it does                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Algorithm                            | FSRS or SM-2. The plugin was built around FSRS, so that is the recommended choice.                              |
| Target request retention             | How likely you want to be to remember a card when it comes up. Higher means more frequent reviews.              |
| Maximum interval                     | The longest gap, in days, allowed between two reviews of a card.                                                |
| Flashcard deck tags / Hint deck tags | The tags that mark a note as a deck or as a hint deck.                                                          |
| Show interval previews               | Show the next review time on the rating buttons.                                                                |
| Duplicate detection mode             | Whether the cleanup command treats cards as duplicates when they are identical or when they share a first line. |
| Data folder path                     | The vault folder where your review progress is saved.                                                           |
| Games                                | Sound effects for Blast, where the game records are saved, and a button to reset them.                          |

## Related

[Mobile-Translate](https://github.com/kfirgumay2005-hash) is my other plugin. Its output builder can create new cards at the press of a button when configured for this card format.

## License

[0-BSD](LICENSE)

Markdown

# Mobile-SR

Spaced Repetition with mobile support

## How to Write Cards

The plugin automatically detects several card formats within your Markdown files:

1. Multi-line Question & Answer
   Use a single question mark (`?`) for a standard single-direction card, or a double question mark (`??`) for a reversed card (tests both ways).

What is the capital of Japan?
Hint: starts with T
?
Tokyo

2. Single-line Cards

    Unidirectional (::):
    Markdown

    Capital of Spain :: Madrid

    Bidirectional (:::): Automatically creates two flashcards (forward and reverse).
    Markdown

    Water ::: H2O

3. Cloze Deletions

Use double equal signs (==) around the word or phrase you want to hide:
Markdown

The central configuration file for Obsidian plugins is ==data.json==.

⚠️ The Critical Importance of Empty Lines

For the plugin's parser to work seamlessly, you must maintain empty lines before and after cards, and especially between questions and answers or consecutive cards.

    Empty lines prevent the plugin from confusing an answer line with the next question.

    Tip: If you have an existing note with dense or cramped cards, you can use the built-in command:

    Separate Cards with Spaces in Active Note

    The plugin will scan the note and automatically add the necessary spacing between cards.

🔄 Dashboard & Deck Management

Clicking the plugin's icon in the ribbon bar or running the command Open Spaced Repetition Dashboard opens the central management window:

    Deck Selection: Displays all decks (Markdown file names) that have cards due for review (Due). Each deck has its own Start button to launch a focused review session for that specific deck only.

    Automated Garbage Collection: Every time the dashboard opens, the plugin scans your vault. If any card stored in data.json has been deleted from your notes, the plugin automatically detects it and removes it from data.json, keeping your database clean.

    Reviewed Cards Status Table: A central table displaying all the flashcards you've already studied, complete with live text search, calculated remaining time until the next review, and current intervals.

⚙️ Plugin Settings Overview

You can customize your learning experience in the plugin settings:

    Algorithm: Choose between SM2 (the classic spaced repetition algorithm) and FSRS (a modern, science-based algorithm that adapts based on stability and difficulty).

    Request Retention: The target retention rate over time (primarily relevant for the FSRS algorithm).

    Maximum Interval: The maximum limit of days a card can reach between reviews.

    Show Interval on Buttons: Option to display expected interval times (e.g., 10m, 3d, 2mo) directly on the rating buttons (Again, Hard, Good, Easy) during reviews.

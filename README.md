# Mobile-SR

Spaced Repetition with mobile support

## How to Write Cards

Look at the attachment to see how to define cards.

Add #flashcards at the top of the card.

⚠️ The Critical Importance of Hyphens (-)

For the plugin to work you must maintain hyphens before and after cards just as described above , without the ().
If you want to export someone else's deck from quizlet for example then paste into an AI and ask to put the question mark between the word and it's meaning and also to add the hyphens and send it to you as Plaintext , then you can paste the output to the markdown and perform this command to clean your deck from extra spaces and duplicates:
Mobile-SR: Fix Cards Spacing and Remove Duplicates

🔄 Dashboard & Deck Management

Clicking the plugin's icon in the ribbon bar or running the command Open Spaced Repetition Dashboard opens the central management window:

    Deck Selection: Displays all decks (Markdown file names) that have cards due for review (Due). Each deck has its own Start button to launch a focused review session for that specific deck only.

    Automated Garbage Collection: Every time the dashboard opens, the plugin scans your vault. If any card stored in data.json has been deleted from your notes, the plugin automatically detects it and removes it from data.json, keeping your database clean.

    Reviewed Cards Status Table: A central table displaying all the flashcards you've already studied, complete with live text search, calculated remaining time until the next review, and current intervals.

⚙️ Plugin Settings Overview

Choose a folder in which the cards due date will be saved.

You can customize your learning experience in the plugin settings:

    Algorithm: It was mainly built around FSRS so i recommend to stick with it.

    Request Retention: The target retention rate over time (primarily relevant for the FSRS algorithm).

    Maximum Interval: The maximum limit of days a card can reach between reviews.

    Show Interval on Buttons: Option to display expected interval times (e.g., 10m, 3d, 2mo) directly on the rating buttons (Again, Hard, Good, Easy) during reviews.

I would also like to recommend my other plugin Mobile-Translate which uses an output builder which lets you create new cards with the press of a button if configured correctly.

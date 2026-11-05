# Asking the user

Every request for the user's input goes through the host's structured question tool: `AskUserQuestion` in Claude Code, or the equivalent tool in another host. Never ask in prose at the end of a message and stop.

## When to ask

- A question you cannot answer from the request, the code or the repository's conventions.
- A choice between options that changes what you build.
- Approval of a design, mockup or plan the user asked to see first.
- Confirmation before an action the user has not already authorized.

Do not ask what the code, the docs or a sensible default already answers.

## How to ask

- One question per decision, with concrete options; put the recommended option first and mark it "(Recommended)".
- Make each question self-contained: the user may see only the dialog, so name the items you ask about and what you found.
- Show a design or mockup (screenshots or files) before asking for its approval, so the dialog refers to something the user can see.

## Approval gates

- When the user asks to see a design or plan first, implement nothing until they approve it through the question tool: no commits, pushes or pull requests for that work.
- A reply that changes details, or answers only part of what you asked, is not approval. Update the design, show it again and ask again.
- If the host has no question tool, ask in plain text and stop; never proceed on an assumed answer.

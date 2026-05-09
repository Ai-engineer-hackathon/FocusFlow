# FocusFlow

Chrome extension for technical reading. Highlight confusing text on a page, click
Explain, and FocusFlow streams a short primer in context.

## Endpoints

`POST /api/primer`

Streams Server-Sent Events:

```json
{
  "selectedText": "Because the callback inside useEffect forms a closure...",
  "title": "Understanding React Hooks",
  "url": "https://example.com/react-hooks",
  "previousParagraph": "The paragraph before the selected text...",
  "paragraph": "The paragraph containing the selected text...",
  "nextParagraph": "The paragraph after the selected text...",
  "codeContext": [
    "useEffect(() => {\n  fetchRoom(roomId)\n}, [roomId])"
  ]
}
```

Events:

- `start` with the selected text
- `delta` with `{ "text": "..." }`
- `done` when complete

## Local Setup

1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
2. Run `npm run dev`.
3. Point the extension at `http://localhost:3000`.
4. Load `extension/` as an unpacked Chrome extension.
5. Highlight text on a technical page and click `Explain`.

## Smoke Check

```bash
npm run smoke
```

This validates endpoint input/error handling without calling OpenAI.

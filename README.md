# FocusFlow Backend

Backend for the FocusFlow Chrome extension demo.

## Endpoints

`POST /api/analyze`

Request:

```json
{
  "url": "https://example.com/react-hooks",
  "title": "Understanding React Hooks",
  "paragraphs": ["...", "..."]
}
```

Response:

```json
{
  "load_bearing_paragraph_index": 3,
  "concepts": [
    {
      "name": "closures",
      "reason": "The paragraph relies on closure capture to explain useEffect dependencies.",
      "confidence": 0.92
    }
  ],
  "should_show_banner": true,
  "model": "gpt-5.5",
  "cached": false
}
```

`POST /api/primer`

Streams Server-Sent Events:

```json
{
  "concept": "closures",
  "title": "Understanding React Hooks",
  "previousParagraph": "...",
  "paragraph": "Because the callback inside useEffect forms a closure...",
  "nextParagraph": "..."
}
```

Events:

- `start` with the concept
- `delta` with `{ "text": "..." }`
- `done` when complete

## Local Setup

1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
2. Run `npm run dev`.
3. Point the extension at `http://localhost:3000`.

## Smoke Check

```bash
npm run smoke
```

This validates endpoint input/error handling without calling OpenAI.

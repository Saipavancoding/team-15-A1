# QuickQuiz backend

## Run locally

```powershell
npm install
npm start
```

The server serves the frontend on port `4000` by default. Configure `PORT`, `JWT_SECRET`, and `MONGO_URI` in `.env` as needed.

## Seed quiz data into Neon

The repository question bank contains 300 questions across six courses. Pull Neon variables into the repository root, then run:

```powershell
neon env pull
npm run seed:neon
```

`seed:neon` uses `DATABASE_URL_UNPOOLED` for the schema/write operation, creates `quiz_questions` and its indexes, and safely upserts the contents of `questions.json`.

The application reads the seeded Neon question bank when `DATABASE_URL` is configured. Verify the connection with:

```text
GET /api/neon/health
GET /api/questions?course=HTML&limit=10
```

The existing Mongoose collections remain available for the application’s current user, attempt, bookmark, challenge, reward, and feature records.

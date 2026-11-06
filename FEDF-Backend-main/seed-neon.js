require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL_UNPOOLED or DATABASE_URL is required.');
  process.exit(1);
}

const source = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
const questions = Array.isArray(source) ? source : source.value;
if (!Array.isArray(questions) || questions.length === 0) {
  console.error('questions.json does not contain a non-empty array.');
  process.exit(1);
}

const questionId = (question, index) => String(question._id || question.id || crypto
  .createHash('sha1')
  .update(`${String(question.course || 'course')}:${String(question.question || index)}`)
  .digest('hex')
  .slice(0, 16));

async function main() {
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 2 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS quiz_questions (
        id TEXT PRIMARY KEY,
        course TEXT NOT NULL,
        topic_id TEXT,
        question TEXT NOT NULL,
        options JSONB NOT NULL,
        answer TEXT NOT NULL,
        difficulty TEXT,
        explanation TEXT,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        source_index INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS quiz_questions_course_idx ON quiz_questions (course);
      CREATE INDEX IF NOT EXISTS quiz_questions_topic_idx ON quiz_questions (topic_id);
    `);

    const statement = `
      INSERT INTO quiz_questions
        (id, course, topic_id, question, options, answer, difficulty, explanation, tags, source_index)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10)
      ON CONFLICT (id) DO UPDATE SET
        course = EXCLUDED.course,
        topic_id = EXCLUDED.topic_id,
        question = EXCLUDED.question,
        options = EXCLUDED.options,
        answer = EXCLUDED.answer,
        difficulty = EXCLUDED.difficulty,
        explanation = EXCLUDED.explanation,
        tags = EXCLUDED.tags,
        source_index = EXCLUDED.source_index,
        updated_at = NOW()
    `;

    for (let index = 0; index < questions.length; index += 1) {
      const item = questions[index];
      await client.query(statement, [
        questionId(item, index),
        String(item.course || 'General').trim(),
        item.topicId ? String(item.topicId).trim() : null,
        String(item.question || '').trim(),
        JSON.stringify(Array.isArray(item.options) ? item.options : []),
        String(item.answer || '').trim(),
        item.difficulty ? String(item.difficulty).trim() : null,
        item.explanation ? String(item.explanation).trim() : null,
        JSON.stringify(Array.isArray(item.tags) ? item.tags : []),
        index
      ]);
    }

    await client.query('COMMIT');
    const result = await client.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(DISTINCT course)::int AS courses
      FROM quiz_questions
    `);
    console.log(JSON.stringify({ seeded: questions.length, ...result.rows[0] }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(`Neon quiz seed failed: ${error.message}`);
  process.exit(1);
});

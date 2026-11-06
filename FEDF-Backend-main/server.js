require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrcElem: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"]
    }
  }
}));
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const jwtSecretFile = path.join(__dirname, '.jwt-secret');
let localJwtSecret = process.env.JWT_SECRET || '';
if (!localJwtSecret) {
  try {
    localJwtSecret = fs.readFileSync(jwtSecretFile, 'utf8').trim();
  } catch (error) {
    localJwtSecret = crypto.randomBytes(32).toString('hex');
    if (process.env.NETLIFY !== 'true') {
      try {
        fs.writeFileSync(jwtSecretFile, localJwtSecret, { encoding: 'utf8', mode: 0o600 });
      } catch (writeError) {
        console.warn('Unable to persist JWT secret; using an in-memory secret:', writeError.message);
      }
    }
  }
}
const JWT_SECRET = localJwtSecret;
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});
let useFileDb = !MONGO_URI;
let questionsCache = [];
let projectsCache = [];
let attemptsCache = [];
let usersCache = [];
let bookmarksCache = [];
let challengeAttemptsCache = [];
let rewardsCache = [];
let studyPlansCache = [];
let flashcardsCache = [];
let flashcardProgressCache = [];
let mockExamsCache = [];
let mockExamAttemptsCache = [];
let discussionsCache = [];
let commentsCache = [];
let reportsCache = [];
let certificatesCache = [];
let neonQuestionsCache = [];

function readJsonArray(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8') || '[]');
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.value)) return parsed.value;
    return [];
  } catch (e) {
    return [];
  }
}

function loadFileDb() {
  console.warn('Running in FILE DB fallback mode (serving from local JSON files)');
  questionsCache = readJsonArray('questions.json');
  projectsCache = readJsonArray('projects.json');
  attemptsCache = readJsonArray('attempts.json');
  usersCache = readJsonArray('users.json');
  bookmarksCache = readJsonArray('bookmarks.json');
  challengeAttemptsCache = readJsonArray('challenge-attempts.json');
  rewardsCache = readJsonArray('rewards.json');
  studyPlansCache = readJsonArray('study-plans.json');
  flashcardsCache = readJsonArray('flashcards.json');
  flashcardProgressCache = readJsonArray('flashcard-progress.json');
  mockExamsCache = readJsonArray('mock-exams.json');
  mockExamAttemptsCache = readJsonArray('mock-exam-attempts.json');
  discussionsCache = readJsonArray('discussions.json');
  commentsCache = readJsonArray('comments.json');
  reportsCache = readJsonArray('reports.json');
  certificatesCache = readJsonArray('certificates.json');
}

const databaseReady = useFileDb
  ? Promise.resolve(loadFileDb())
  : mongoose.connect(MONGO_URI, { useNewUrlParser:true, useUnifiedTopology:true })
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => {
      console.error('MongoDB connection error; switching to FILE DB fallback:', err.message);
      useFileDb = true;
      loadFileDb();
    });

const neonPool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;
const neonReady = neonPool
  ? neonPool.query(`
      CREATE TABLE IF NOT EXISTS quickquiz_runtime (
        id INTEGER PRIMARY KEY,
        service TEXT NOT NULL,
        last_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO quickquiz_runtime (id, service)
      VALUES (1, 'quickquiz')
      ON CONFLICT (id) DO UPDATE SET last_started_at = NOW();
      CREATE TABLE IF NOT EXISTS quickquiz_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'student',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS quickquiz_users_email_idx ON quickquiz_users (email);
    `).then(async () => {
      await loadNeonQuestions();
      console.log('Connected to Neon Postgres');
    })
  : Promise.resolve();

const questionSchema = new mongoose.Schema({}, { strict: false });
const projectSchema  = new mongoose.Schema({}, { strict: false });
const attemptSchema  = new mongoose.Schema({
  userId: String,
  course: String,
  score: Number,
  total: Number,
  percent: Number,
  questionIds: [String],
  mistakes: [String],
  answers: [{
    questionId: String,
    topicId: String,
    submitted: String,
    correct: Boolean,
    correctAnswer: String,
    question: String,
    explanation: String,
    difficulty: String
  }],
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

const Question = mongoose.model('Question', questionSchema, 'questions');
const Project  = mongoose.model('Project', projectSchema, 'projects');
const Attempt  = mongoose.model('Attempt', attemptSchema, 'attempts');
const User = mongoose.model('User', new mongoose.Schema({
  name: String, email: { type: String, unique: true }, passwordHash: String, role: String,
  createdAt: { type: Date, default: Date.now }
}), 'users');
const Bookmark = mongoose.model('Bookmark', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  questionId: { type: String, required: true },
  course: { type: String, required: true },
  topicId: String,
  question: String,
  options: [String],
  answer: String
}, { timestamps: true }));
Bookmark.schema.index({ userId: 1, questionId: 1 }, { unique: true });
const ChallengeAttempt = mongoose.model('ChallengeAttempt', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  dateKey: { type: String, required: true },
  questionIds: [String],
  score: Number,
  total: Number,
  percent: Number,
  points: Number,
  createdAt: { type: Date, default: Date.now }
}));
ChallengeAttempt.schema.index({ userId: 1, dateKey: 1 }, { unique: true });
const Reward = mongoose.model('Reward', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  attemptId: { type: String, required: true },
  points: Number,
  badge: String,
  createdAt: { type: Date, default: Date.now }
}));
Reward.schema.index({ userId: 1, attemptId: 1 }, { unique: true });
const StudyPlan = mongoose.model('StudyPlan', new mongoose.Schema({
  userId: { type: String, required: true, index: true }, course: { type: String, required: true },
  topic: String, task: { type: String, required: true }, scheduledDate: { type: Date, required: true },
  duration: { type: Number, min: 1, max: 1440, required: true }, goal: String,
  status: { type: String, enum: ['pending', 'completed'], default: 'pending' }
}, { timestamps: true }));
const Flashcard = mongoose.model('Flashcard', new mongoose.Schema({
  userId: { type: String, required: true, index: true }, course: { type: String, required: true },
  topic: String, question: { type: String, required: true }, answer: { type: String, required: true },
  difficulty: { type: String, enum: ['Easy', 'Medium', 'Hard'], default: 'Medium' }
}, { timestamps: true }));
const FlashcardProgress = mongoose.model('FlashcardProgress', new mongoose.Schema({
  userId: { type: String, required: true, index: true }, flashcardId: { type: String, required: true },
  remembered: Boolean, dueAt: { type: Date, required: true }, reviewedAt: { type: Date, default: Date.now }
}, { timestamps: true }));
FlashcardProgress.schema.index({ userId: 1, flashcardId: 1 }, { unique: true });
const MockExam = mongoose.model('MockExam', new mongoose.Schema({
  teacherId: { type: String, required: true }, title: { type: String, required: true },
  description: String, course: { type: String, required: true }, questionIds: [String],
  durationMinutes: { type: Number, min: 1, max: 600, required: true },
  totalMarks: { type: Number, min: 1, required: true }, negativeMark: { type: Number, min: 0, default: 0 },
  published: { type: Boolean, default: false }
}, { timestamps: true }));
const MockExamAttempt = mongoose.model('MockExamAttempt', new mongoose.Schema({
  examId: { type: String, required: true, index: true }, userId: { type: String, required: true, index: true },
  answers: mongoose.Schema.Types.Mixed, score: Number, submittedAt: { type: Date, default: Date.now }
}, { timestamps: true }));
MockExamAttempt.schema.index({ examId: 1, userId: 1 }, { unique: true });
const Discussion = mongoose.model('Discussion', new mongoose.Schema({
  userId: { type: String, required: true, index: true }, course: { type: String, required: true },
  topic: String, title: { type: String, required: true }, body: { type: String, required: true },
  pinned: { type: Boolean, default: false }, likes: { type: Number, default: 0 }, acceptedCommentId: String
}, { timestamps: true }));
const Comment = mongoose.model('Comment', new mongoose.Schema({
  discussionId: { type: String, required: true, index: true }, userId: { type: String, required: true },
  body: { type: String, required: true }, official: { type: Boolean, default: false }, likes: { type: Number, default: 0 }
}, { timestamps: true }));
const Report = mongoose.model('Report', new mongoose.Schema({
  discussionId: { type: String, required: true }, commentId: String, userId: { type: String, required: true },
  reason: { type: String, required: true }, status: { type: String, default: 'open' }
}, { timestamps: true }));
const Certificate = mongoose.model('Certificate', new mongoose.Schema({
  userId: { type: String, required: true, index: true }, course: { type: String, required: true },
  certificateNumber: { type: String, unique: true, required: true }, issuedAt: { type: Date, default: Date.now }
}, { timestamps: true }));
Certificate.schema.index({ userId: 1, course: 1 }, { unique: true });

function persistFile(name, value) {
  const records = Array.isArray(value) ? value : [];
  fs.writeFileSync(path.join(__dirname, name), JSON.stringify(records, null, 2));
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id || user._id), role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

const neonUserStore = () => Boolean(neonPool && !MONGO_URI);
async function findNeonUserByEmail(email) {
  if (!neonUserStore()) return null;
  const result = await neonPool.query(
    'SELECT id, name, email, password_hash AS "passwordHash", role, created_at AS "createdAt" FROM quickquiz_users WHERE email = $1',
    [email]
  );
  return result.rows[0] || null;
}
async function findNeonUserById(id) {
  if (!neonUserStore()) return null;
  const result = await neonPool.query(
    'SELECT id, name, email, password_hash AS "passwordHash", role, created_at AS "createdAt" FROM quickquiz_users WHERE id = $1',
    [String(id)]
  );
  return result.rows[0] || null;
}

function authenticateUser(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    next();
  };
}

function getQuestionId(question, index) {
  if (question._id || question.id) return String(question._id || question.id);
  return crypto.createHash('sha1')
    .update(`${String(question.course || 'course')}:${String(question.question || index)}`)
    .digest('hex')
    .slice(0, 16);
}

function normalizeQuestion(question, index) {
  const id = getQuestionId(question, index);
  const courseId = String(question.courseId || question.course || '').toLowerCase().replace(/\s+/g, '-');
  return {
    id,
    questionId: id,
    courseId,
    topicId: String(question.topicId || courseId),
    course: question.course,
    type: question.type || 'mcq',
    question: question.question,
    options: question.options || question.choices || [],
    tags: question.tags || []
  };
}

async function loadNeonQuestions() {
  if (!neonPool) return;
  const result = await neonPool.query(`
    SELECT id, course, topic_id, question, options, answer, difficulty, explanation, tags
    FROM quiz_questions
    ORDER BY source_index ASC
  `).catch(() => null);
  if (!result?.rows?.length) return;
  neonQuestionsCache = result.rows.map(item => ({
    id: String(item.id),
    course: item.course,
    topicId: item.topic_id,
    question: item.question,
    options: Array.isArray(item.options) ? item.options : [],
    answer: item.answer,
    difficulty: item.difficulty,
    explanation: item.explanation,
    tags: Array.isArray(item.tags) ? item.tags : []
  }));
  console.log(`Loaded ${neonQuestionsCache.length} quiz questions from Neon`);
}

async function getQuestionBank() {
  if (neonQuestionsCache.length) return neonQuestionsCache;
  if (useFileDb) return questionsCache;
  return Question.find({}).lean();
}

function currentUserId(req) {
  return req.get('x-user-id') || req.body?.userId || req.query?.userId || null;
}

function saveAttempt(attempt) {
  attemptsCache.push(attempt);
  persistFile('attempts.json', attemptsCache);
}

function getQuestionsByIds(questionIds) {
  const wanted = new Set(questionIds.map(String));
  return questionsCache.filter((question, index) => wanted.has(getQuestionId(question, index)));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function publicUser(userId) {
  const user = usersCache.find(item => String(item.id) === String(userId));
  return user ? { id: String(user.id), name: user.name } : null;
}

function allAttempts() {
  return attemptsCache.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function isEligibleUser(user) {
  if (!user || !(user.id || user._id) || !user.name || !user.email) return false;
  const marker = `${user.name} ${user.email}`.toLowerCase();
  const generatedTestEmail = /^(feature-|ui-|verify-|challenge-check-|bookmarker-|learner-|startup-|inspect-|real-)/.test(String(user.email).toLowerCase());
  return !generatedTestEmail && !/(^|[-_. ])(test|feature|ui|verification)([-_. @]|$)/.test(marker);
}

function isEligibleAttempt(attempt, userMap = new Map(usersCache.map(user => [String(user.id), user]))) {
  const user = userMap.get(String(attempt?.userId));
  const total = Number(attempt?.total);
  const answers = Array.isArray(attempt?.answers) ? attempt.answers : [];
  return isEligibleUser(user) &&
    Boolean(attempt?.course) &&
    Number.isInteger(total) &&
    total > 0 &&
    answers.length === total &&
    Array.isArray(attempt?.questionIds) &&
    attempt.questionIds.length === total &&
    Number.isFinite(Number(attempt?.percent)) &&
    Number(attempt.percent) >= 0 &&
    Number(attempt.percent) <= 100;
}

async function getEligibleAttempts(course) {
  if (useFileDb) {
    const userMap = new Map(usersCache.map(user => [String(user.id), user]));
    return attemptsCache.filter(attempt => (!course || String(attempt.course) === course) && isEligibleAttempt(attempt, userMap));
  }
  const users = await User.find({ name: { $exists: true }, email: { $exists: true } }).lean();
  const eligibleIds = users.filter(isEligibleUser).map(user => user._id);
  const filter = { userId: { $in: eligibleIds } };
  if (course) filter.course = course;
  const attempts = await Attempt.find(filter).lean();
  return attempts.filter(attempt => isEligibleAttempt(attempt, new Map(users.map(user => [String(user._id), user]))));
}

function rewardPoints(attempt) {
  return Math.max(0, Number(attempt.score || 0)) * 10;
}

function saveJsonRecord(file, cache, record) {
  cache.push(record);
  persistFile(file, cache);
}

async function awardAttemptReward(userId, attempt) {
  const attemptId = String(attempt.id || attempt._id);
  const reward = { id: crypto.randomUUID(), userId: String(userId), attemptId, points: Number(attempt.score || 0) * 10, badge: attempt.percent === 100 ? 'Perfect Score' : 'Quiz Finisher', createdAt: new Date().toISOString() };
  if (useFileDb) {
    if (!rewardsCache.some(item => item.userId === reward.userId && item.attemptId === reward.attemptId)) saveJsonRecord('rewards.json', rewardsCache, reward);
  } else {
    await Reward.create(reward).catch(err => { if (err.code !== 11000) throw err; });
  }
}

// Health endpoint
app.get('/api/health', (req,res)=> res.json({ok:true, msg:'QuickQuiz backend running'}));
app.get('/api/neon/health', async (req, res) => {
  if (!neonPool) return res.status(503).json({ ok: false, error: 'Neon DATABASE_URL is not configured' });
  try {
    const result = await neonPool.query('SELECT service, last_started_at FROM quickquiz_runtime WHERE id = 1');
    res.json({ ok: true, provider: 'neon-postgres', ...result.rows[0] });
  } catch (err) {
    res.status(503).json({ ok: false, provider: 'neon-postgres', error: err.message });
  }
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password, role = 'student' } = req.body || {};
    if (!name || !email || !password || String(password).length < 6) {
      return res.status(400).json({ error: 'name, email and a password of at least 6 characters are required' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = useFileDb
      ? (neonUserStore() ? await findNeonUserByEmail(normalizedEmail) : usersCache.find(u => u.email === normalizedEmail))
      : await User.findOne({ email: normalizedEmail });
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });
    const user = {
      id: crypto.randomUUID(),
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(String(password), 12),
      role: role === 'teacher' ? 'teacher' : 'student',
      createdAt: new Date().toISOString()
    };
    if (neonUserStore()) {
      await neonPool.query(
        'INSERT INTO quickquiz_users (id, name, email, password_hash, role, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [user.id, user.name, user.email, user.passwordHash, user.role, user.createdAt]
      );
    } else if (useFileDb) {
      usersCache.push(user);
      persistFile('users.json', usersCache);
    } else {
      const created = await User.create({
        name: user.name,
        email: user.email,
        passwordHash: user.passwordHash,
        role: user.role,
        createdAt: user.createdAt
      });
      user.id = String(created._id);
    }
    res.status(201).json({
      token: signToken(user),
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const user = useFileDb
      ? (neonUserStore() ? await findNeonUserByEmail(normalizedEmail) : usersCache.find(u => u.email === normalizedEmail))
      : await User.findOne({ email: normalizedEmail });
    const passwordMatches = user ? await bcrypt.compare(String(password), user.passwordHash) : false;
    if (!user || !passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    res.json({
      token: signToken(user),
      user: { id: String(user.id || user._id), name: user.name, email: user.email, role: user.role }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', authenticateUser, async (req, res) => {
  try {
    const user = useFileDb
      ? (neonUserStore() ? await findNeonUserById(req.auth.sub) : usersCache.find(item => String(item.id) === String(req.auth.sub)))
      : await User.findById(req.auth.sub).lean();
    if (!user) return res.status(404).json({ error: 'User account not found' });
    res.json({ user: { id: String(user.id || user._id), name: user.name, email: user.email, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/questions', async (req, res) => {
  try {
    const course = req.query.course;
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    if (!course) return res.status(400).json({ error: 'course required' });
    const questionBank = await getQuestionBank();
    if (neonQuestionsCache.length || useFileDb) {
      const pool = questionBank.filter(q => String(q.course).toLowerCase() === String(course).toLowerCase());
      // Random sample
      const shuffled = pool.sort(() => 0.5 - Math.random());
      const docs = shuffled.slice(0, limit).map(normalizeQuestion);
      return res.json(docs);
    }
    const docs = questionBank.filter(q => String(q.course).toLowerCase() === String(course).toLowerCase());
    res.json(docs.sort(() => 0.5 - Math.random()).slice(0, limit).map(normalizeQuestion));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/projects', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const course = req.query.course;
    if (useFileDb) {
      let results = projectsCache.slice(0, 100);
      if (course) results = results.filter(p => String(p.course).toLowerCase() === String(course).toLowerCase());
      if (q) {
        const ql = q.toLowerCase();
        results = results.filter(p => (p.title || '').toLowerCase().includes(ql) || (p.description || '').toLowerCase().includes(ql));
      }
      return res.json(results.slice(0,100));
    }
    const filter = {};
    if (course) filter.course = course;
    if (q) filter.$text = { $search: q };
    const docs = await Project.find(filter).limit(100);
    res.json(docs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/attempts', authenticateUser, async (req, res) => {
  try {
    const { course, questionIds = [], answers = [] } = req.body || {};
    const userId = String(req.auth.sub);
    if (!course || !Array.isArray(questionIds) || questionIds.length === 0 || !Array.isArray(answers) || answers.length !== questionIds.length) {
      return res.status(400).json({ error: 'course, questionIds and answers are required' });
    }
    const allQuestions = await getQuestionBank();
    const byId = new Map(allQuestions.map((q, index) => [getQuestionId(q, index), q]));
    const evaluated = questionIds.map((id, index) => {
      const question = byId.get(String(id));
      const submitted = String(answers[index] ?? '').trim().toLowerCase();
      const expected = String(question?.answer ?? '').trim().toLowerCase();
      return { questionId: String(id), topicId: question?.topicId ? String(question.topicId) : null, correct: Boolean(question && submitted !== '' && submitted === expected) };
    });
    if (evaluated.some(item => !byId.has(item.questionId))) return res.status(400).json({ error: 'One or more quiz questions are invalid' });
    const score = evaluated.filter(item => item.correct).length;
    const total = evaluated.length;
    const percent = total ? Math.round(score / total * 100) : 0;
    const attempt = { userId: String(userId), course, score, total, percent,
      questionIds: evaluated.map(item => item.questionId), mistakes: evaluated.filter(item => !item.correct).map(item => item.questionId),
      answers: answers.map((answer, index) => ({
        questionId: evaluated[index].questionId,
        submitted: String(answer ?? ''),
        correct: evaluated[index].correct,
        correctAnswer: String(allQuestions.find((q, qIndex) => getQuestionId(q, qIndex) === evaluated[index].questionId)?.answer ?? ''),
        question: String(allQuestions.find((q, qIndex) => getQuestionId(q, qIndex) === evaluated[index].questionId)?.question ?? ''),
        explanation: String(allQuestions.find((q, qIndex) => getQuestionId(q, qIndex) === evaluated[index].questionId)?.explanation ?? ''),
        difficulty: String(allQuestions.find((q, qIndex) => getQuestionId(q, qIndex) === evaluated[index].questionId)?.difficulty ?? ''),
        topicId: evaluated[index].topicId
      })),
      createdAt: new Date().toISOString() };
    if (useFileDb) {
      attempt.id = crypto.randomUUID();
      saveAttempt(attempt);
      await awardAttemptReward(userId, attempt);
      return res.status(201).json(attempt);
    }
    const a = await Attempt.create(attempt);
    await awardAttemptReward(userId, a);
    res.status(201).json(a);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function smartInsightsHandler(req, res) {
  try {
    const userId = String(req.auth.sub);
    const course = String(req.query.course || '').trim();
    const range = String(req.query.range || 'all').toLowerCase();
    const days = { '7': 7, '30': 30, '90': 90, '7d': 7, '30d': 30, '90d': 90, week: 7, month: 30, quarter: 90 }[range];
    const since = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
    const allAttempts = useFileDb
      ? attemptsCache.filter(attempt => String(attempt.userId) === userId)
      : await Attempt.find({ userId }).sort({ createdAt: 1 }).lean();
    const attempts = allAttempts
      .filter(attempt => !course || String(attempt.course) === course)
      .filter(attempt => !since || new Date(attempt.createdAt).getTime() >= since)
      .filter(attempt => Number(attempt.total) > 0 && Number.isFinite(Number(attempt.percent)));
    const summary = {
      totalQuizzes: attempts.length,
      averageScore: attempts.length ? Math.round(attempts.reduce((sum, attempt) => sum + Number(attempt.percent), 0) / attempts.length) : null,
      highestScore: attempts.length ? Math.max(...attempts.map(attempt => Number(attempt.percent))) : null,
      totalQuestions: attempts.reduce((sum, attempt) => sum + Number(attempt.total || 0), 0),
      correctAnswers: attempts.reduce((sum, attempt) => sum + Math.min(Number(attempt.score || 0), Number(attempt.total || 0)), 0),
      overallAccuracy: null,
      incorrectAnswers: 0,
      weeklyQuizzes: attempts.filter(attempt => new Date(attempt.createdAt).getTime() >= Date.now() - 7 * 86400000).length,
      monthlyQuizzes: attempts.filter(attempt => new Date(attempt.createdAt).getTime() >= Date.now() - 30 * 86400000).length,
      latestScore: null,
      previousScore: null,
      scoreImprovement: null,
      consistency: null
    };
    summary.incorrectAnswers = Math.max(0, summary.totalQuestions - summary.correctAnswers);
    summary.overallAccuracy = summary.totalQuestions ? Math.round(summary.correctAnswers / summary.totalQuestions * 100) : null;
    if (attempts.length) {
      summary.latestScore = Number(attempts[attempts.length - 1].percent);
      summary.previousScore = attempts.length > 1 ? Number(attempts[attempts.length - 2].percent) : null;
      summary.scoreImprovement = summary.previousScore === null ? null : summary.latestScore - summary.previousScore;
      const activeDays = new Set(attempts.map(attempt => new Date(attempt.createdAt).toISOString().slice(0, 10))).size;
      const spanDays = Math.max(1, Math.ceil((new Date(attempts[attempts.length - 1].createdAt) - new Date(attempts[0].createdAt)) / 86400000) + 1);
      summary.consistency = Math.round(activeDays / spanDays * 100);
    }
    const topics = {};
    for (const attempt of attempts) {
      for (const answer of Array.isArray(attempt.answers) ? attempt.answers : []) {
        let topic = answer.topicId;
        if (!topic && useFileDb) {
          const question = questionsCache.find((item, index) => getQuestionId(item, index) === answer.questionId);
          topic = question?.topicId;
        }
        if (!topic) continue;
        const key = String(topic);
        topics[key] = topics[key] || { topic: key, total: 0, correct: 0, courses: new Set() };
        topics[key].total++;
        if (answer.correct) topics[key].correct++;
        topics[key].courses.add(attempt.course);
      }
    }
    const topicRows = Object.values(topics).map(item => {
      const accuracy = Math.round(item.correct / item.total * 100);
      return {
        topic: item.topic,
        total: item.total,
        correct: item.correct,
        incorrect: item.total - item.correct,
        accuracy,
        category: accuracy >= 80 ? 'Strong' : accuracy >= 50 ? 'Average' : 'Weak',
        courses: [...item.courses],
        practiceHref: `quizz.html?course=${encodeURIComponent([...item.courses][0] || '')}`
      };
    }).sort((a, b) => a.accuracy - b.accuracy);
    const trend = attempts.map(attempt => ({ date: attempt.createdAt, score: Number(attempt.percent), course: attempt.course }));
    const courses = [...new Set(allAttempts.map(attempt => attempt.course).filter(Boolean))].sort();
    const recommendations = topicRows.filter(item => item.category === 'Weak').slice(0, 3).map(item => ({
      type: 'weak',
      text: `Your ${item.topic} accuracy is ${item.accuracy}%. Practice more ${item.topic} questions.`,
      href: item.practiceHref
    }));
    if (summary.scoreImprovement !== null && summary.scoreImprovement > 0) {
      recommendations.push({ type: 'improvement', text: `Your latest score improved by ${summary.scoreImprovement} percentage points compared with your previous attempt.`, href: 'review.html' });
    }
    if (topicRows.some(item => item.category === 'Strong')) {
      const strong = topicRows.find(item => item.category === 'Strong');
      recommendations.push({ type: 'strong', text: `Your ${strong.topic} performance is strong at ${strong.accuracy}%.`, href: strong.practiceHref });
    }
    res.json({
      hasData: attempts.length > 0,
      filters: { course: course || 'all', range: days ? String(days) : 'all' },
      availableCourses: courses,
      summary,
      topicAnalysisAvailable: topicRows.length > 0,
      topics: topicRows,
      insights: topicRows,
      weakTopics: topicRows.filter(item => item.category === 'Weak'),
      strongTopics: topicRows.filter(item => item.category === 'Strong'),
      averageTopics: topicRows.filter(item => item.category === 'Average'),
      trend,
      recommendations
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

app.get('/api/analytics/smart-insights', authenticateUser, smartInsightsHandler);
app.get('/api/insights', authenticateUser, smartInsightsHandler);

app.get('/api/bookmarks', authenticateUser, async (req, res) => {
  const userId = String(req.auth.sub);
  const course = req.query.course ? String(req.query.course) : null;
  const topic = req.query.topic ? String(req.query.topic) : null;
  const records = useFileDb
    ? bookmarksCache.filter(item => String(item.userId) === userId && (!course || item.course === course) && (!topic || item.topicId === topic))
    : await Bookmark.find({ userId, ...(course ? { course } : {}), ...(topic ? { topicId: topic } : {}) }).sort({ course: 1, createdAt: -1 }).lean();
  res.json(records);
});

app.post('/api/bookmarks', authenticateUser, async (req, res) => {
  try {
    const { questionId } = req.body || {};
    if (!questionId) return res.status(400).json({ error: 'questionId is required' });
    const question = useFileDb
      ? getQuestionsByIds([questionId])[0]
      : await Question.findOne({ $or: [{ _id: questionId }, { id: questionId }] }).lean();
    if (!question) return res.status(404).json({ error: 'Question not found' });
    const userId = String(req.auth.sub);
    const record = { id: crypto.randomUUID(), userId, questionId: String(questionId), course: String(question.course || 'General'), topicId: question.topicId || question.course, difficulty: question.difficulty || 'Unspecified', question: question.question, options: question.options || [], answer: question.answer };
    if (useFileDb) {
      if (bookmarksCache.some(item => item.userId === userId && item.questionId === record.questionId)) return res.status(409).json({ error: 'Question already bookmarked' });
      saveJsonRecord('bookmarks.json', bookmarksCache, record);
    } else {
      await Bookmark.create(record);
    }
    res.status(201).json(record);
  } catch (err) { res.status(err.code === 11000 ? 409 : 500).json({ error: err.code === 11000 ? 'Question already bookmarked' : err.message }); }
});

app.get('/api/bookmarks/practice', authenticateUser, async (req, res) => {
  const userId = String(req.auth.sub);
  const records = useFileDb ? bookmarksCache.filter(item => String(item.userId) === userId) : await Bookmark.find({ userId }).sort({ createdAt: 1 }).lean();
  res.json(records.map(item => ({ ...item, answer: undefined })));
});

app.delete('/api/bookmarks/:questionId', authenticateUser, async (req, res) => {
  const userId = String(req.auth.sub);
  if (useFileDb) {
    bookmarksCache = bookmarksCache.filter(item => !(item.userId === userId && item.questionId === String(req.params.questionId)));
    persistFile('bookmarks.json', bookmarksCache);
  } else await Bookmark.deleteOne({ userId, questionId: String(req.params.questionId) });
  res.json({ ok: true });
});

app.get('/api/daily-challenge', authenticateUser, async (req, res) => {
  const dateKey = todayKey();
  const pool = await getQuestionBank();
  if (pool.length < 5) return res.status(503).json({ error: 'Daily challenge needs at least five questions in the question bank' });
  const questions = pool.map((item, index) => ({ item, id: getQuestionId(item, index) }))
    .sort((a, b) => crypto.createHash('sha1').update(`${dateKey}:${a.id}`).digest('hex').localeCompare(crypto.createHash('sha1').update(`${dateKey}:${b.id}`).digest('hex')))
    .slice(0, 5).map(({ item, id }) => ({ ...normalizeQuestion(item, 0), questionId: id }));
  const existing = useFileDb ? challengeAttemptsCache.find(item => item.userId === String(req.auth.sub) && item.dateKey === dateKey) : await ChallengeAttempt.findOne({ userId: String(req.auth.sub), dateKey }).lean();
  res.json({ dateKey, completed: Boolean(existing), questions, attempt: existing || null });
});

app.post('/api/daily-challenge/attempts', authenticateUser, async (req, res) => {
  try {
    const userId = String(req.auth.sub);
    const dateKey = todayKey();
    const existing = useFileDb ? challengeAttemptsCache.find(item => item.userId === userId && item.dateKey === dateKey) : await ChallengeAttempt.findOne({ userId, dateKey });
    if (existing) return res.status(409).json({ error: 'Daily challenge already completed today', attempt: existing });
    const { questionIds = [], answers = [] } = req.body || {};
    if (!Array.isArray(questionIds) || questionIds.length < 5) return res.status(400).json({ error: 'Five challenge questions are required' });
    const pool = await getQuestionBank();
    const byId = new Map(pool.map((item, index) => [getQuestionId(item, index), item]));
    const score = questionIds.reduce((total, id, index) => total + (String(byId.get(String(id))?.answer || '').toLowerCase() === String(answers[index] || '').trim().toLowerCase() ? 1 : 0), 0);
    if (questionIds.length !== 5 || new Set(questionIds.map(String)).size !== 5) return res.status(400).json({ error: 'Exactly five unique challenge questions are required' });
    const attempt = { id: crypto.randomUUID(), userId, dateKey, questionIds: questionIds.map(String), score, total: questionIds.length, percent: Math.round(score / questionIds.length * 100), points: score * 10, createdAt: new Date().toISOString() };
    if (useFileDb) saveJsonRecord('challenge-attempts.json', challengeAttemptsCache, attempt); else await ChallengeAttempt.create(attempt);
    res.status(201).json(attempt);
  } catch (err) { res.status(err.code === 11000 ? 409 : 500).json({ error: err.code === 11000 ? 'Daily challenge already completed today' : err.message }); }
});

app.get('/api/daily-challenge/history', authenticateUser, async (req, res) => {
  const userId = String(req.auth.sub);
  const history = useFileDb
    ? challengeAttemptsCache.filter(item => String(item.userId) === userId).sort((a, b) => String(b.dateKey).localeCompare(String(a.dateKey)))
    : await ChallengeAttempt.find({ userId }).sort({ dateKey: -1 }).lean();
  let streak = 0;
  let cursor = new Date();
  const dates = new Set(history.map(item => item.dateKey));
  while (dates.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  res.json({ streak, history });
});

app.get('/api/review/:attemptId', authenticateUser, async (req, res) => {
  const userId = String(req.auth.sub);
  const attempt = useFileDb ? attemptsCache.find(item => item.id === req.params.attemptId) : await Attempt.findById(req.params.attemptId).lean();
  if (!attempt || String(attempt.userId) !== userId) return res.status(404).json({ error: 'Quiz attempt not found' });
  const previous = (useFileDb ? attemptsCache : await Attempt.find({ userId: attempt.userId, course: attempt.course }).sort({ createdAt: -1 }).lean()).filter(item => String(item.id || item._id) !== req.params.attemptId)[0] || null;
  res.json({ attempt, previous, comparison: previous ? { change: attempt.percent - previous.percent, direction: attempt.percent >= previous.percent ? 'improved' : 'declined' } : null });
});

app.get('/api/review/:attemptId/pdf', authenticateUser, async (req, res) => {
  const userId = String(req.auth.sub);
  const attempt = useFileDb ? attemptsCache.find(item => item.id === req.params.attemptId) : await Attempt.findById(req.params.attemptId).lean();
  if (!attempt || String(attempt.userId) !== userId) return res.status(404).json({ error: 'Quiz attempt not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="quickquiz-${attempt.course}-review.pdf"`);
  const doc = new PDFDocument();
  doc.pipe(res);
  doc.fontSize(20).text('QuickQuiz Quiz Report');
  doc.moveDown().fontSize(13).text(`Course: ${attempt.course}`);
  doc.text(`Score: ${attempt.score}/${attempt.total} (${attempt.percent}%)`);
  doc.text(`Completed: ${new Date(attempt.createdAt).toLocaleString()}`);
  doc.moveDown().fontSize(12);
  for (const answer of attempt.answers || []) {
    doc.text(`${answer.correct ? 'Correct' : 'Incorrect'} - Submitted: ${answer.submitted || 'Unanswered'} - Correct answer: ${answer.correctAnswer || 'Unavailable'}`);
  }
  doc.end();
});

app.get('/api/review/:attemptId/retry', authenticateUser, async (req, res) => {
  const userId = String(req.auth.sub);
  const attempt = useFileDb ? attemptsCache.find(item => item.id === req.params.attemptId) : await Attempt.findById(req.params.attemptId).lean();
  if (!attempt || String(attempt.userId) !== userId) return res.status(404).json({ error: 'Quiz attempt not found' });
  const incorrect = (attempt.answers || []).filter(answer => !answer.correct);
  const questions = [];
  for (const answer of incorrect) {
    const question = useFileDb
      ? questionsCache.find((item, index) => getQuestionId(item, index) === answer.questionId)
      : await Question.findOne({ $or: [{ _id: answer.questionId }, { id: answer.questionId }] }).lean();
    if (question) {
      const normalized = normalizeQuestion(question, 0);
      questions.push({ questionId: answer.questionId, type: normalized.type, question: normalized.question, options: normalized.options, topicId: normalized.topicId, course: normalized.course });
    }
  }
  res.json({ course: attempt.course, questions });
});

app.get('/api/leaderboard', authenticateUser, async (req, res) => {
  const course = req.query.course ? String(req.query.course) : null;
  const since = req.query.period === 'weekly' ? Date.now() - 7 * 24 * 60 * 60 * 1000 : null;
  const attempts = (await getEligibleAttempts(course)).filter(item => !since || new Date(item.createdAt).getTime() >= since);
  const users = useFileDb ? usersCache : await User.find({}).lean();
  const userMap = new Map(users.map(user => [String(user.id || user._id), user]));
  const challenges = useFileDb ? challengeAttemptsCache : await ChallengeAttempt.find({}).lean();
  const totals = {};
  for (const attempt of attempts) {
    const id = String(attempt.userId);
    const user = userMap.get(id);
    if (!isEligibleUser(user)) continue;
    totals[id] = totals[id] || { user: { id, name: user.name }, score: 0, attempts: 0, xp: 0, courses: new Set() };
    totals[id].score = Math.max(totals[id].score, Number(attempt.percent || 0));
    totals[id].attempts++;
    totals[id].xp += rewardPoints(attempt);
    totals[id].courses.add(attempt.course);
  }
  for (const challenge of challenges) {
    if (since && new Date(challenge.createdAt).getTime() < since) continue;
    const id = String(challenge.userId);
    if (totals[id]) totals[id].xp += Number(challenge.points || 0);
  }
  const leaderboard = Object.values(totals)
    .sort((a, b) => b.score - a.score || b.xp - a.xp || b.attempts - a.attempts || a.user.name.localeCompare(b.user.name))
    .map((item, index) => ({ rank: index + 1, user: item.user, score: item.score, attempts: item.attempts, xp: item.xp, courses: [...item.courses] }));
  const courses = [...new Set(attempts.map(item => item.course).filter(Boolean))].sort().map(courseName => {
    const courseTotals = {};
    attempts.filter(item => item.course === courseName).forEach(attempt => {
      const id = String(attempt.userId);
      const user = userMap.get(id);
      if (!isEligibleUser(user)) return;
      courseTotals[id] = courseTotals[id] || { user: { id, name: user.name }, score: 0, attempts: 0, xp: 0 };
      courseTotals[id].score = Math.max(courseTotals[id].score, Number(attempt.percent || 0));
      courseTotals[id].attempts++;
      courseTotals[id].xp += rewardPoints(attempt);
    });
    const courseLeaderboard = Object.values(courseTotals)
      .sort((a, b) => b.score - a.score || b.xp - a.xp || a.user.name.localeCompare(b.user.name))
      .map((item, index) => ({ rank: index + 1, ...item }));
    return { course: courseName, leaderboard: courseLeaderboard };
  });
  res.json({
    leaderboard,
    current: leaderboard.find(item => item.user.id === String(req.auth.sub)) || null,
    weekly: since ? leaderboard : null,
    courses
  });
});

app.get('/api/achievements', authenticateUser, async (req, res) => {
  const userId = String(req.auth.sub);
  const attempts = useFileDb ? attemptsCache.filter(item => String(item.userId) === userId) : await Attempt.find({ userId }).lean();
  const challenges = useFileDb ? challengeAttemptsCache.filter(item => String(item.userId) === userId) : await ChallengeAttempt.find({ userId }).lean();
  const rewards = useFileDb ? rewardsCache.filter(item => String(item.userId) === userId) : await Reward.find({ userId }).lean();
  res.json({
    xp: rewards.reduce((sum, item) => sum + Number(item.points || 0), 0) + challenges.reduce((sum, item) => sum + Number(item.points || 0), 0),
    achievements: [
      { id: 'first-quiz', title: 'First Steps', unlocked: attempts.length >= 1 },
      { id: 'five-quizzes', title: 'Consistent Learner', unlocked: attempts.length >= 5 },
      { id: 'challenge-streak', title: 'Daily Challenger', unlocked: challenges.length >= 3 },
      { id: 'perfect-score', title: 'Perfect Score', unlocked: attempts.some(item => item.percent === 100) }
    ]
  });
});

app.get('/api/dashboard', authenticateUser, async (req, res) => {
  try {
    const userId = String(req.auth.sub);
    const attempts = useFileDb
      ? attemptsCache.filter(a => String(a.userId) === userId).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt))
      : await Attempt.find({ userId }).sort({ createdAt: 1 }).lean();
    const totalAttempts = attempts.length;
    const averagePercent = totalAttempts ? Math.round(attempts.reduce((sum, a) => sum + Number(a.percent || 0), 0) / totalAttempts) : 0;
    const topicCounts = {};
    attempts.flatMap(a => a.mistakes || []).forEach(id => { topicCounts[id] = (topicCounts[id] || 0) + 1; });
    const uniqueCourses = [...new Set(attempts.map(a => a.course).filter(Boolean))];
    const lastDates = [...new Set(attempts.map(a => new Date(a.createdAt).toISOString().slice(0, 10)))].sort().reverse();
    let streak = 0;
    let cursor = new Date();
    for (const date of lastDates) {
      if (date === cursor.toISOString().slice(0, 10)) { streak++; cursor.setDate(cursor.getDate() - 1); }
      else if (streak === 0) { cursor.setDate(cursor.getDate() - 1); if (date === cursor.toISOString().slice(0, 10)) { streak++; cursor.setDate(cursor.getDate() - 1); } else break; }
      else break;
    }
    const achievements = [
      { id: 'first-quiz', title: 'First Steps', unlocked: totalAttempts >= 1 },
      { id: 'five-quizzes', title: 'Consistent Learner', unlocked: totalAttempts >= 5 },
      { id: 'perfect-score', title: 'Perfect Score', unlocked: attempts.some(a => a.total > 0 && a.score === a.total) },
      { id: 'three-topics', title: 'Curious Mind', unlocked: uniqueCourses.length >= 3 }
    ];
    res.json({ userId, stats: { totalAttempts, averagePercent, bestPercent: attempts.reduce((best, a) => Math.max(best, Number(a.percent || 0)), 0), streak },
      attempts, mistakes: Object.entries(topicCounts).map(([questionId, count]) => ({ questionId, count })), achievements,
      roadmap: uniqueCourses.map((course, index) => ({ courseId: course.toLowerCase(), title: course, order: index + 1, status: index === 0 ? 'in-progress' : 'recommended' })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/challenges', async (req, res) => {
  res.json([
    { id: 'daily-quiz', title: 'Daily Quiz', description: 'Complete one quiz today', requirement: 1, metric: 'attempts' },
    { id: 'accuracy-builder', title: 'Accuracy Builder', description: 'Reach 80% on a quiz', requirement: 80, metric: 'percent' },
    { id: 'course-explorer', title: 'Course Explorer', description: 'Practice three courses', requirement: 3, metric: 'courses' }
  ]);
});

app.get('/api/roadmap/:userId', authenticateUser, async (req, res) => {
  try {
    const userId = String(req.params.userId);
    if (String(req.auth.sub) !== userId) {
      return res.status(403).json({ error: 'You can only access your own roadmap' });
    }
    const attempts = useFileDb
      ? attemptsCache.filter(a => String(a.userId) === userId)
      : await Attempt.find({ userId }).lean();
    const courses = [...new Set(attempts.map(a => a.course).filter(Boolean))];
    res.json(courses.map((course, index) => ({
      courseId: course.toLowerCase().replace(/\s+/g, '-'), title: course,
      order: index + 1, status: index === 0 ? 'in-progress' : 'recommended'
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/attempts/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    if (useFileDb) {
      const atts = attemptsCache.filter(a => String(a.userId) === String(userId)).sort((a,b)=> new Date(a.createdAt) - new Date(b.createdAt));
      return res.json(atts);
    }
    const attempts = await Attempt.find({ userId }).sort({ createdAt: 1 });
    res.json(attempts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function cleanText(value, max = 5000) {
  return String(value || '').replace(/<[^>]*>/g, '').trim().slice(0, max);
}
function newRecord(fields) { return { id: crypto.randomUUID(), ...fields, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }
async function ownedRecords(Model, cache, file, userId, query = {}) {
  if (useFileDb) return cache.filter(item => String(item.userId) === String(userId) && Object.entries(query).every(([key, value]) => String(item[key]) === String(value)));
  return Model.find({ userId, ...query }).sort({ createdAt: -1 }).lean();
}
async function findRecord(Model, cache, id) {
  if (useFileDb) return cache.find(item => String(item.id) === String(id));
  return Model.findById(id).lean();
}
async function insertRecord(Model, cache, file, record) {
  if (useFileDb) { saveJsonRecord(file, cache, record); return record; }
  const { id, ...mongoRecord } = record;
  return Model.create(mongoRecord);
}
async function updateOwned(Model, cache, file, id, userId, updates) {
  if (useFileDb) {
    const item = cache.find(record => String(record.id) === String(id) && String(record.userId) === String(userId));
    if (!item) return null;
    Object.assign(item, updates, { updatedAt: new Date().toISOString() }); persistFile(file, cache); return item;
  }
  return Model.findOneAndUpdate({ _id: id, userId }, updates, { new: true }).lean();
}
async function deleteOwned(Model, cache, file, id, userId) {
  if (useFileDb) {
    const index = cache.findIndex(record => String(record.id) === String(id) && String(record.userId) === String(userId));
    if (index < 0) return false; cache.splice(index, 1); persistFile(file, cache); return true;
  }
  return Boolean(await Model.deleteOne({ _id: id, userId }));
}

app.get('/api/study-plans', authenticateUser, async (req, res) => {
  try { res.json(await ownedRecords(StudyPlan, studyPlansCache, 'study-plans.json', req.auth.sub)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/study-plans', authenticateUser, async (req, res) => {
  try {
    const { course, topic, task, scheduledDate, duration, goal } = req.body || {};
    if (!course || !task || !scheduledDate || !Number.isInteger(Number(duration)) || Number(duration) < 1) return res.status(400).json({ error: 'course, task, scheduledDate and positive duration are required' });
    const record = newRecord({ userId: String(req.auth.sub), course: cleanText(course, 120), topic: cleanText(topic, 120), task: cleanText(task), scheduledDate, duration: Number(duration), goal: cleanText(goal, 500), status: 'pending' });
    res.status(201).json(await insertRecord(StudyPlan, studyPlansCache, 'study-plans.json', record));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/study-plans/:id', authenticateUser, async (req, res) => {
  try {
    const updates = {}; ['course', 'topic', 'task', 'scheduledDate', 'goal', 'status'].forEach(key => { if (req.body?.[key] !== undefined) updates[key] = cleanText(req.body[key], key === 'task' ? 5000 : 500); });
    if (req.body?.duration !== undefined) updates.duration = Number(req.body.duration);
    const result = await updateOwned(StudyPlan, studyPlansCache, 'study-plans.json', req.params.id, req.auth.sub, updates);
    if (!result) return res.status(404).json({ error: 'Study task not found' }); res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/study-plans/:id', authenticateUser, async (req, res) => {
  try { if (!await deleteOwned(StudyPlan, studyPlansCache, 'study-plans.json', req.params.id, req.auth.sub)) return res.status(404).json({ error: 'Study task not found' }); res.status(204).end(); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/study-plans/recommendations', authenticateUser, async (req, res) => {
  try {
    const attempts = useFileDb ? attemptsCache.filter(a => String(a.userId) === String(req.auth.sub)) : await Attempt.find({ userId: req.auth.sub }).lean();
    const topicTotals = {};
    attempts.forEach(a => (a.answers || []).forEach(answer => { if (!answer.topicId) return; const row = topicTotals[answer.topicId] || { total: 0, correct: 0 }; row.total++; if (answer.correct) row.correct++; topicTotals[answer.topicId] = row; }));
    res.json(Object.entries(topicTotals).filter(([, value]) => value.correct / value.total < 0.5).map(([topic, value]) => ({ topic, accuracy: Math.round(value.correct / value.total * 100), reason: 'Based on your quiz performance' })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/flashcards', authenticateUser, async (req, res) => {
  try { res.json(await ownedRecords(Flashcard, flashcardsCache, 'flashcards.json', req.auth.sub)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/flashcards', authenticateUser, async (req, res) => {
  try {
    const { course, topic, question, answer, difficulty = 'Medium' } = req.body || {};
    if (!course || !question || !answer || !['Easy', 'Medium', 'Hard'].includes(difficulty)) return res.status(400).json({ error: 'course, question, answer and valid difficulty are required' });
    const record = newRecord({ userId: String(req.auth.sub), course: cleanText(course, 120), topic: cleanText(topic, 120), question: cleanText(question), answer: cleanText(answer), difficulty });
    res.status(201).json(await insertRecord(Flashcard, flashcardsCache, 'flashcards.json', record));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/flashcards/:id', authenticateUser, async (req, res) => {
  try {
    const updates = {}; ['course', 'topic', 'question', 'answer'].forEach(key => { if (req.body?.[key] !== undefined) updates[key] = cleanText(req.body[key]); });
    if (req.body?.difficulty && ['Easy', 'Medium', 'Hard'].includes(req.body.difficulty)) updates.difficulty = req.body.difficulty;
    const result = await updateOwned(Flashcard, flashcardsCache, 'flashcards.json', req.params.id, req.auth.sub, updates);
    if (!result) return res.status(404).json({ error: 'Flashcard not found' }); res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/flashcards/:id', authenticateUser, async (req, res) => {
  try { if (!await deleteOwned(Flashcard, flashcardsCache, 'flashcards.json', req.params.id, req.auth.sub)) return res.status(404).json({ error: 'Flashcard not found' }); res.status(204).end(); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/flashcards/due', authenticateUser, async (req, res) => {
  try {
    const cards = await ownedRecords(Flashcard, flashcardsCache, 'flashcards.json', req.auth.sub);
    const progress = await ownedRecords(FlashcardProgress, flashcardProgressCache, 'flashcard-progress.json', req.auth.sub);
    const due = new Map(progress.map(item => [String(item.flashcardId), item]));
    res.json(cards.filter(card => !due.has(String(card.id || card._id)) || new Date(due.get(String(card.id || card._id)).dueAt) <= new Date()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/flashcards/:id/review', authenticateUser, async (req, res) => {
  try {
    const card = await findRecord(Flashcard, flashcardsCache, req.params.id);
    if (!card || String(card.userId) !== String(req.auth.sub)) return res.status(404).json({ error: 'Flashcard not found' });
    const remembered = Boolean(req.body?.remembered); const days = remembered ? (card.difficulty === 'Hard' ? 2 : 7) : 1;
    const progress = { id: crypto.randomUUID(), userId: String(req.auth.sub), flashcardId: String(req.params.id), remembered, dueAt: new Date(Date.now() + days * 86400000).toISOString(), reviewedAt: new Date().toISOString() };
    if (useFileDb) {
      const index = flashcardProgressCache.findIndex(item => item.userId === progress.userId && item.flashcardId === progress.flashcardId);
      if (index >= 0) flashcardProgressCache[index] = progress; else flashcardProgressCache.push(progress); persistFile('flashcard-progress.json', flashcardProgressCache);
    } else await FlashcardProgress.findOneAndUpdate({ userId: req.auth.sub, flashcardId: req.params.id }, progress, { upsert: true, new: true });
    res.json(progress);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mock-exams', authenticateUser, async (req, res) => {
  try { const exams = useFileDb ? mockExamsCache.filter(e => e.published || e.teacherId === String(req.auth.sub)) : await MockExam.find({ $or: [{ published: true }, { teacherId: req.auth.sub }] }).lean(); res.json(exams); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/mock-exams', authenticateUser, requireRole('teacher'), async (req, res) => {
  try {
    const { title, description, course, durationMinutes, totalMarks, negativeMark = 0, questionIds = [], published = false } = req.body || {};
    if (!title || !course || !Number(durationMinutes) || !Number(totalMarks) || !Array.isArray(questionIds) || !questionIds.length) return res.status(400).json({ error: 'title, course, duration, total marks and questions are required' });
    const record = newRecord({ teacherId: String(req.auth.sub), title: cleanText(title, 200), description: cleanText(description), course: cleanText(course, 120), durationMinutes: Number(durationMinutes), totalMarks: Number(totalMarks), negativeMark: Number(negativeMark), questionIds: questionIds.map(String), published: Boolean(published) });
    res.status(201).json(await insertRecord(MockExam, mockExamsCache, 'mock-exams.json', record));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/mock-exams/:id', authenticateUser, async (req, res) => {
  try {
    const exam = await findRecord(MockExam, mockExamsCache, req.params.id);
    if (!exam || (!exam.published && String(exam.teacherId) !== String(req.auth.sub))) return res.status(404).json({ error: 'Examination not found' });
    const ids = (exam.questionIds || []).map(String); const pool = await getQuestionBank();
    res.json({ ...exam, questions: pool.map((q, i) => ({ q, id: getQuestionId(q, i) })).filter(item => ids.includes(item.id)).map(item => normalizeQuestion(item.q, pool.indexOf(item.q))) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/mock-exams/:id/submit', authenticateUser, async (req, res) => {
  try {
    const exam = await findRecord(MockExam, mockExamsCache, req.params.id);
    if (!exam || !exam.published) return res.status(404).json({ error: 'Published examination not found' });
    const existing = useFileDb ? mockExamAttemptsCache.find(a => a.examId === String(req.params.id) && a.userId === String(req.auth.sub)) : await MockExamAttempt.findOne({ examId: req.params.id, userId: req.auth.sub });
    if (existing) return res.status(409).json({ error: 'You have already submitted this examination', attempt: existing });
    const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    const pool = await getQuestionBank(); let score = 0;
    for (const [id, answer] of Object.entries(answers)) { const index = pool.findIndex((q, i) => getQuestionId(q, i) === id); if (index >= 0 && String(pool[index].answer).trim().toLowerCase() === String(answer).trim().toLowerCase()) score++; }
    const result = newRecord({ examId: String(req.params.id), userId: String(req.auth.sub), answers, score, submittedAt: new Date().toISOString() });
    if (useFileDb) saveJsonRecord('mock-exam-attempts.json', mockExamAttemptsCache, result); else await MockExamAttempt.create(result);
    res.status(201).json({ ...result, percentage: Math.round(score / Math.max(1, (exam.questionIds || []).length) * 100) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/mock-exams/:id/results', authenticateUser, async (req, res) => {
  try {
    const result = useFileDb ? mockExamAttemptsCache.find(a => a.examId === String(req.params.id) && a.userId === String(req.auth.sub)) : await MockExamAttempt.findOne({ examId: req.params.id, userId: req.auth.sub }).lean();
    if (!result) return res.status(404).json({ error: 'Examination result not found' }); res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/discussions', authenticateUser, async (req, res) => {
  try {
    const { course, topic, search, sort = 'newest' } = req.query; let records = useFileDb ? discussionsCache.slice() : await Discussion.find({}).lean();
    records = records.filter(item => (!course || item.course === course) && (!topic || item.topic === topic) && (!search || `${item.title} ${item.body}`.toLowerCase().includes(String(search).toLowerCase())));
    records.sort((a, b) => sort === 'popular' ? Number(b.likes || 0) - Number(a.likes || 0) : new Date(b.createdAt) - new Date(a.createdAt)); res.json(records);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/discussions', authenticateUser, async (req, res) => {
  try { const { course, topic, title, body } = req.body || {}; if (!course || !title || !body) return res.status(400).json({ error: 'course, title and body are required' }); const record = newRecord({ userId: String(req.auth.sub), course: cleanText(course, 120), topic: cleanText(topic, 120), title: cleanText(title, 200), body: cleanText(body) }); res.status(201).json(await insertRecord(Discussion, discussionsCache, 'discussions.json', record)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/discussions/:id/comments', authenticateUser, async (req, res) => {
  try { res.json(useFileDb ? commentsCache.filter(c => String(c.discussionId) === String(req.params.id)) : await Comment.find({ discussionId: req.params.id }).sort({ createdAt: 1 }).lean()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/discussions/:id/comments', authenticateUser, async (req, res) => {
  try { if (!cleanText(req.body?.body)) return res.status(400).json({ error: 'Comment body is required' }); const record = newRecord({ discussionId: String(req.params.id), userId: String(req.auth.sub), body: cleanText(req.body.body) }); res.status(201).json(await insertRecord(Comment, commentsCache, 'comments.json', record)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/discussions/:id/comments/:commentId/accept', authenticateUser, async (req, res) => {
  try {
    const discussion = await findRecord(Discussion, discussionsCache, req.params.id);
    const comment = useFileDb ? commentsCache.find(item => String(item.id) === String(req.params.commentId) && String(item.discussionId) === String(req.params.id)) : await Comment.findOne({ _id: req.params.commentId, discussionId: req.params.id }).lean();
    if (!discussion || !comment) return res.status(404).json({ error: 'Discussion or comment not found' });
    if (String(discussion.userId) !== String(req.auth.sub) && req.auth.role !== 'teacher') return res.status(403).json({ error: 'Only the author or a teacher can accept an answer' });
    if (useFileDb) { discussion.acceptedCommentId = String(req.params.commentId); persistFile('discussions.json', discussionsCache); } else await Discussion.findByIdAndUpdate(req.params.id, { acceptedCommentId: req.params.commentId });
    res.json({ acceptedCommentId: String(req.params.commentId) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/discussions/:id/like', authenticateUser, async (req, res) => {
  try { const item = useFileDb ? discussionsCache.find(d => String(d.id) === String(req.params.id)) : await Discussion.findByIdAndUpdate(req.params.id, { $inc: { likes: 1 } }, { new: true }).lean(); if (!item) return res.status(404).json({ error: 'Discussion not found' }); if (useFileDb) { item.likes = Number(item.likes || 0) + 1; persistFile('discussions.json', discussionsCache); } res.json(item); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/discussions/:id/pin', authenticateUser, requireRole('teacher'), async (req, res) => {
  try {
    const pinned = Boolean(req.body?.pinned);
    if (useFileDb) { const item = discussionsCache.find(discussion => String(discussion.id) === String(req.params.id)); if (!item) return res.status(404).json({ error: 'Discussion not found' }); item.pinned = pinned; persistFile('discussions.json', discussionsCache); return res.json(item); }
    const item = await Discussion.findByIdAndUpdate(req.params.id, { pinned }, { new: true }).lean();
    if (!item) return res.status(404).json({ error: 'Discussion not found' }); res.json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/discussions/:id/report', authenticateUser, async (req, res) => {
  try { const record = newRecord({ discussionId: String(req.params.id), userId: String(req.auth.sub), reason: cleanText(req.body?.reason, 500), status: 'open' }); if (!record.reason) return res.status(400).json({ error: 'Report reason is required' }); res.status(201).json(await insertRecord(Report, reportsCache, 'reports.json', record)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/reports/:id', authenticateUser, requireRole('teacher'), async (req, res) => {
  try {
    const status = ['open', 'reviewed', 'resolved', 'dismissed'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Invalid report status' });
    if (useFileDb) { const item = reportsCache.find(report => String(report.id) === String(req.params.id)); if (!item) return res.status(404).json({ error: 'Report not found' }); item.status = status; persistFile('reports.json', reportsCache); return res.json(item); }
    const item = await Report.findByIdAndUpdate(req.params.id, { status }, { new: true }).lean();
    if (!item) return res.status(404).json({ error: 'Report not found' }); res.json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function courseEligibility(userId, course) {
  const attempts = useFileDb ? attemptsCache.filter(a => String(a.userId) === String(userId) && String(a.course) === String(course) && Number(a.total) > 0) : await Attempt.find({ userId, course }).lean();
  return { eligible: attempts.length > 0 && attempts.reduce((sum, item) => sum + Number(item.percent || 0), 0) / attempts.length >= 70, attempts };
}
app.get('/api/certificates', authenticateUser, async (req, res) => {
  try { res.json(await ownedRecords(Certificate, certificatesCache, 'certificates.json', req.auth.sub)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/certificates', authenticateUser, async (req, res) => {
  try {
    const course = cleanText(req.body?.course, 120); if (!course) return res.status(400).json({ error: 'course is required' });
    const eligibility = await courseEligibility(req.auth.sub, course); if (!eligibility.eligible) return res.status(403).json({ error: 'Complete a course quiz with an average score of at least 70% to earn this certificate' });
    const existing = useFileDb ? certificatesCache.find(c => c.userId === String(req.auth.sub) && c.course === course) : await Certificate.findOne({ userId: req.auth.sub, course });
    if (existing) return res.json(existing);
    const record = newRecord({ userId: String(req.auth.sub), course, certificateNumber: `QQ-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}` });
    res.status(201).json(await insertRecord(Certificate, certificatesCache, 'certificates.json', record));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/certificates/verify/:number', async (req, res) => {
  try { const certificate = useFileDb ? certificatesCache.find(c => c.certificateNumber === String(req.params.number)) : await Certificate.findOne({ certificateNumber: req.params.number }).lean(); if (!certificate) return res.status(404).json({ error: 'Certificate not found' }); res.json({ valid: true, certificateNumber: certificate.certificateNumber, course: certificate.course, issuedAt: certificate.issuedAt }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/certificates/:id/pdf', authenticateUser, async (req, res) => {
  try {
    const certificate = await findRecord(Certificate, certificatesCache, req.params.id); if (!certificate || String(certificate.userId) !== String(req.auth.sub)) return res.status(404).json({ error: 'Certificate not found' });
    const user = useFileDb ? usersCache.find(item => String(item.id) === String(req.auth.sub)) : await User.findById(req.auth.sub).lean(); const doc = new PDFDocument(); res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${certificate.certificateNumber}.pdf"`); doc.pipe(res); doc.fontSize(28).text('QuickQuiz Certificate', { align: 'center' }); doc.moveDown(); doc.fontSize(18).text('This certifies that', { align: 'center' }); doc.moveDown(); doc.fontSize(26).text(user?.name || 'QuickQuiz Student', { align: 'center' }); doc.moveDown(); doc.fontSize(18).text(`has successfully completed ${certificate.course}`, { align: 'center' }); doc.moveDown(); doc.fontSize(12).text(`Certificate: ${certificate.certificateNumber}`, { align: 'center' }); doc.text(`Issued: ${new Date(certificate.issuedAt).toLocaleDateString()}`, { align: 'center' }); doc.end();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 4000;
// If the frontend folder exists next to the backend, serve it as static files
const frontendPath = path.join(__dirname, '..', 'FEDF-QuickQuiz-main', 'FEDF-QuickQuiz-main');
if (fs.existsSync(frontendPath)) {
  console.log('Serving frontend from', frontendPath);
  app.use(express.static(frontendPath));
  // Serve indexx.html at root for convenience
  app.get('/', (req, res) => res.sendFile(path.join(frontendPath, 'indexx.html')));
}

const startupReady = Promise.all([databaseReady, neonReady]);

if (process.env.NETLIFY !== 'true') {
  startupReady.then(() => {
    app.listen(PORT, () => console.log('Server listening on port', PORT));
  }).catch(err => {
    console.error('Application startup failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { app, startupReady };

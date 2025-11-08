require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || '';
const fs = require('fs');
const useFileDb = !MONGO_URI;
let questionsCache = [];
let projectsCache = [];
let attemptsCache = [];

if (useFileDb) {
  console.warn('MONGO_URI not set — running in FILE DB fallback mode (serving from questions.json/projects.json)');
  try {
    const qtxt = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
    questionsCache = JSON.parse(qtxt || '[]');
  } catch (e) { questionsCache = []; }
  try {
    const ptxt = fs.readFileSync(path.join(__dirname, 'projects.json'), 'utf8');
    projectsCache = JSON.parse(ptxt || '[]');
  } catch (e) { projectsCache = []; }
  try {
    const atxt = fs.readFileSync(path.join(__dirname, 'attempts.json'), 'utf8');
    attemptsCache = JSON.parse(atxt || '[]');
  } catch (e) { attemptsCache = []; }
} else {
  mongoose.connect(MONGO_URI, { useNewUrlParser:true, useUnifiedTopology:true })
  .then(()=> console.log('Connected to MongoDB'))
  .catch(err=> { console.error('MongoDB connection error:', err); process.exit(1); });
}

const questionSchema = new mongoose.Schema({}, { strict: false });
const projectSchema  = new mongoose.Schema({}, { strict: false });
const attemptSchema  = new mongoose.Schema({
  userId: String,
  course: String,
  score: Number,
  total: Number,
  percent: Number,
  createdAt: { type: Date, default: Date.now }
});

const Question = mongoose.model('Question', questionSchema, 'questions');
const Project  = mongoose.model('Project', projectSchema, 'projects');
const Attempt  = mongoose.model('Attempt', attemptSchema, 'attempts');

// Health endpoint
app.get('/api/health', (req,res)=> res.json({ok:true, msg:'QuickQuiz backend running'}));

app.get('/api/questions', async (req, res) => {
  try {
    const course = req.query.course;
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    if (!course) return res.status(400).json({ error: 'course required' });
    if (useFileDb) {
      const pool = questionsCache.filter(q => String(q.course).toLowerCase() === String(course).toLowerCase());
      // Random sample
      const shuffled = pool.sort(() => 0.5 - Math.random());
      const docs = shuffled.slice(0, limit);
      return res.json(docs);
    }
    const docs = await Question.aggregate([{ $match: { course } }, { $sample: { size: limit } }]);
    res.json(docs);
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

app.post('/api/attempts', async (req, res) => {
  try {
    const { userId, course, score, total } = req.body;
    const percent = total ? Math.round(score / total * 100) : 0;
    if (useFileDb) {
      const a = { id: Date.now().toString(), userId: userId || null, course, score, total, percent, createdAt: new Date() };
      attemptsCache.push(a);
      try { fs.writeFileSync(path.join(__dirname, 'attempts.json'), JSON.stringify(attemptsCache, null, 2)); } catch(e){}
      return res.json(a);
    }
    const a = await Attempt.create({ userId, course, score, total, percent });
    res.json(a);
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

const PORT = process.env.PORT || 4000;
// If the frontend folder exists next to the backend, serve it as static files
const frontendPath = path.join(__dirname, '..', 'FEDF-QuickQuiz-main', 'FEDF-QuickQuiz-main');
if (fs.existsSync(frontendPath)) {
  console.log('Serving frontend from', frontendPath);
  app.use(express.static(frontendPath));
  // Serve indexx.html at root for convenience
  app.get('/', (req, res) => res.sendFile(path.join(frontendPath, 'indexx.html')));
}

app.listen(PORT, ()=> console.log('Server listening on port', PORT));

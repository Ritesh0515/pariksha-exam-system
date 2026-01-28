const express = require('express')
const session = require('express-session')
const db = require('./db')
require('dotenv').config()

const app = express()

// 1. Middleware
app.use(express.urlencoded({ extended: true }))
app.use(express.json());
app.set('view engine', 'ejs')

// 2. Session Setup
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'fallback_secret',
    resave: false,
    saveUninitialized: true,
  }),
)

// 3. ROUTES

// Root Route
app.get('/', (req, res) => {
  res.redirect('/login')
})

// Login Page
app.get('/login', (req, res) => {
  res.render('login')
})

// Handle Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body
  try {
    // We select the user where email matches AND the password matches after SHA2 encryption
    const [users] = await db.query(
      'SELECT * FROM users WHERE email = ? AND password_hash = SHA2(?, 256)',
      [email, password],
    )

    if (users.length > 0) {
      // Check if the account is active before letting them in
      if (users[0].is_active === 0) {
        return res.send('This account is inactive. Please contact support.')
      }

      req.session.user = users[0]

      // Redirect based on role
      if (users[0].role === 'admin') {
        res.redirect('/admin/dashboard')
      } else {
        res.redirect('/student/dashboard')
      }
    } else {
      // If the query returns nothing, the email or password was wrong
      res.send("Invalid email or password. <a href='/login'>Try again</a>")
    }
  } catch (err) {
    console.error('Login Error:', err)
    res.status(500).send('Database Error: ' + err.message)
  }
})

// --- ADMIN DASHBOARD ---
app.get('/admin/dashboard', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin')
    return res.redirect('/login')

  try {
    const [[{ examCount }]] = await db.query(
      'SELECT COUNT(*) as examCount FROM exams',
    )
    const [[{ subjectCount }]] = await db.query(
      'SELECT COUNT(*) as subjectCount FROM subjects',
    )
    const [[{ studentCount }]] = await db.query(
      "SELECT COUNT(*) as studentCount FROM users WHERE role = 'student'",
    )
    const [recentSubjects] = await db.query(
      'SELECT subject_name FROM subjects ORDER BY subject_id DESC LIMIT 5',
    )

    res.render('admin_dashboard', {
      user: req.session.user,
      stats: {
        exams: examCount || 0,
        subjects: subjectCount || 0,
        students: studentCount || 0,
      },
      activities: recentSubjects,
      currentPage: 'dashboard',
    })
  } catch (err) {
    res.status(500).send('Dashboard Error')
  }
})

// --- EXAM MANAGEMENT ---
app.get('/admin/exams', async (req, res) => {
  try {
    const [subjects] = await db.query('SELECT * FROM subjects')
    const [exams] = await db.query(
      'SELECT e.*, s.subject_name FROM exams e JOIN subjects s ON e.subject_id = s.subject_id',
    )
    res.render('admin_exams', { user: req.session.user, subjects, exams })
  } catch (err) {
    res.status(500).send('Error loading exams')
  }
})

app.post('/admin/exams/add', async (req, res) => {
  const { subject_id, exam_name, duration_minutes, total_marks, pass_marks } =
    req.body
  try {
    await db.query(
      "INSERT INTO exams (subject_id, exam_name, duration_minutes, total_marks, pass_marks, status) VALUES (?, ?, ?, ?, ?, 'draft')",
      [subject_id, exam_name, duration_minutes, total_marks, pass_marks],
    )
    res.redirect('/admin/exams')
  } catch (err) {
    res.status(500).send('Error creating exam')
  }
})

app.post('/admin/exams/update/:id', async (req, res) => {
  const { exam_name, duration_minutes, total_marks, pass_marks } = req.body
  try {
    await db.query(
      'UPDATE exams SET exam_name=?, duration_minutes=?, total_marks=?, pass_marks=? WHERE exam_id=?',
      [exam_name, duration_minutes, total_marks, pass_marks, req.params.id],
    )
    res.redirect('/admin/exams')
  } catch (err) {
    res.status(500).send('Update failed')
  }
})

// DELETE EXAM
app.get('/admin/exams/delete/:id', async (req, res) => {
  try {
    const id = req.params.id
    // This SQL command removes the exam from your database
    await db.query('DELETE FROM exams WHERE exam_id = ?', [id])
    res.redirect('/admin/exams') // Go back to the list after deleting
  } catch (err) {
    console.error(err)
    res
      .status(500)
      .send(
        'Error: Could not delete the exam. Check if questions are still attached.',
      )
  }
})
// --- QUESTION MANAGEMENT ---
app.get('/admin/exams/:examId/questions', async (req, res) => {
  try {
    const [exam] = await db.query('SELECT * FROM exams WHERE exam_id = ?', [
      req.params.examId,
    ])
    const [questions] = await db.query(
      'SELECT * FROM questions WHERE exam_id = ?',
      [req.params.examId],
    )
    res.render('admin_questions', { exam: exam[0], questions })
  } catch (err) {
    res.status(500).send('Error loading questions')
  }
})

app.post('/admin/exams/:examId/questions/add', async (req, res) => {
  const {
    question_text,
    option_a,
    option_b,
    option_c,
    option_d,
    correct_answer,
  } = req.body
  try {
    await db.query(
      'INSERT INTO questions (exam_id, question_text, option_a, option_b, option_c, option_d, correct_answer) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        req.params.examId,
        question_text,
        option_a,
        option_b,
        option_c,
        option_d,
        correct_answer,
      ],
    )
    res.redirect(`/admin/exams/${req.params.examId}/questions`)
  } catch (err) {
    res.status(500).send('Error saving question')
  }
})

// --- SUBJECT MANAGEMENT ---
app.get('/admin/subjects', async (req, res) => {
  try {
    const [courses] = await db.query('SELECT * FROM courses')
    const [subjects] = await db.query(
      'SELECT s.*, c.course_name FROM subjects s JOIN courses c ON s.course_id = c.course_id',
    )
    res.render('admin_subjects', { user: req.session.user, courses, subjects })
  } catch (err) {
    res.status(500).send('Error loading subjects')
  }
})

app.post('/admin/subjects/add', async (req, res) => {
  const { subject_name, subject_code, course_id } = req.body
  try {
    await db.query(
      'INSERT INTO subjects (subject_name, subject_code, course_id, created_by) VALUES (?, ?, ?, ?)',
      [subject_name, subject_code, course_id, req.session.user.user_id],
    )
    res.redirect('/admin/subjects')
  } catch (err) {
    res.status(500).send('Error adding subject')
  }
})

// Route to handle updating a subject
app.post('/admin/subjects/update/:id', async (req, res) => {
  const { subject_name, subject_code, course_id } = req.body
  try {
    await db.query(
      'UPDATE subjects SET subject_name=?, subject_code=?, course_id=? WHERE subject_id=?',
      [subject_name, subject_code, course_id, req.params.id],
    )
    res.redirect('/admin/subjects')
  } catch (err) {
    res.status(500).send('Error updating subject: ' + err.message)
  }
})

app.get('/admin/subjects/delete/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM subjects WHERE subject_id = ?', [req.params.id])
    res.redirect('/admin/subjects')
  } catch (err) {
    res.status(500).send('Subject linked to exam')
  }
})

app.get('/logout', (req, res) => {
  req.session.destroy()
  res.redirect('/login')
})

app.get('/admin/results', async (req, res) => {
    // 1. Security check to ensure only admins enter
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.redirect('/login');
    }

    try {
        // 2. Fetch the results joined with academic details (Roll No & Class)
        const [allResults] = await db.query(`
            SELECT r.*, u.first_name, u.last_name, u.roll_no, u.class_name, e.exam_name 
            FROM results r
            JOIN users u ON r.user_id = u.user_id
            JOIN exams e ON r.exam_id = e.exam_id
            ORDER BY r.submitted_at DESC
        `);

        // 3. Render the page and send the data
        res.render('admin_results', { 
            user: req.session.user, 
            results: allResults,
            currentPage: 'results' 
        });
    } catch (err) {
        console.error("Error fetching results:", err);
        res.status(500).send("Error loading results page: " + err.message);
    }
});

// ==========================================
// STUDENT ROUTES
// ==========================================

// Student Dashboard - Show available exams
app.get('/student/dashboard', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'student') {
        return res.redirect('/login');
    }

    try {
        // Fetch all exams joined with their subject names
        const [exams] = await db.query(`
            SELECT e.*, s.subject_name 
            FROM exams e 
            JOIN subjects s ON e.subject_id = s.subject_id
        `);

        res.render('student_dashboard', { 
            user: req.session.user, 
            exams: exams 
        });
    } catch (err) {
      
        console.error("Student Dashboard SQL Error:", err); 
        res.status(500).send("Error loading student dashboard: " + err.message);
    }
});

// Route to show instructions before starting
app.get('/student/exam/:examId/start', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'student') {
        return res.redirect('/login');
    }

    try {
        const examId = req.params.examId;
        const userId = req.session.user.user_id;

        // 1. One-Attempt Restriction
        const [existing] = await db.query("SELECT result_id FROM results WHERE user_id = ? AND exam_id = ?", [userId, examId]);
        if (existing.length > 0) return res.redirect('/student/history');

        // 2. Fetch Exam Data
        const [exam] = await db.query("SELECT * FROM exams WHERE exam_id = ?", [examId]);
        const [questions] = await db.query("SELECT * FROM questions WHERE exam_id = ?", [examId]);

        // 3. Persistent Timer Logic
        if (!req.session.examEndTime || req.session.currentExamId !== examId) {
            const durationInMs = exam[0].duration_minutes * 60 * 1000;
            req.session.examEndTime = Date.now() + durationInMs;
            req.session.currentExamId = examId;
        }

        const remainingSeconds = Math.max(0, Math.floor((req.session.examEndTime - Date.now()) / 1000));

        res.render('student_exam_attempt', { 
            user: req.session.user, 
            exam: exam[0], 
            questions: questions,
            remainingSeconds: remainingSeconds 
        });
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

// Route to show the actual questions (The Attempt Page)
app.get('/student/exam/:examId/attempt', async (req, res) => {
    // 1. Security Check: Are they logged in as a student?
    if (!req.session.user || req.session.user.role !== 'student') {
        return res.redirect('/login');
    }

    try {
        const examId = req.params.examId;
        const userId = req.session.user.user_id;

        // 2. ONE-ATTEMPT RESTRICTION: Check if a result already exists for this student/exam
        const [existingResult] = await db.query(
            "SELECT result_id FROM results WHERE user_id = ? AND exam_id = ?", 
            [userId, examId]
        );

        if (existingResult.length > 0) {
            // If they already took it, redirect them away (or show a message)
            return res.redirect('/student/history'); 
        }

        // 3. Fetch exam details for the header/timer
        const [exam] = await db.query("SELECT * FROM exams WHERE exam_id = ?", [examId]);
        
        // 4. Fetch all questions for this exam
        const [questions] = await db.query("SELECT * FROM questions WHERE exam_id = ?", [examId]);

        // 5. If everything is clear, let them take the exam
        res.render('student_exam_attempt', { 
            user: req.session.user, 
            exam: exam[0], 
            questions: questions 
        });

    } catch (err) {
        console.error("Exam Attempt Error:", err);
        res.status(500).send("Error starting exam attempt: " + err.message);
    }
});

app.post('/student/exam/:examId/submit', async (req, res) => {
    const examId = req.params.examId;
    const studentAnswers = req.body;
    const userId = req.session.user.user_id; // Get the ID of the logged-in student

    try {
        const [questions] = await db.query("SELECT question_id, correct_answer FROM questions WHERE exam_id = ?", [examId]);
        const [exam] = await db.query("SELECT * FROM exams WHERE exam_id = ?", [examId]);
        
        let score = 0;
        const totalQuestions = questions.length;

        questions.forEach(q => {
            const studentSelection = studentAnswers[`q${q.question_id}`];
            if (studentSelection === q.correct_answer) {
                score++;
            }
        });

        const status = score >= exam[0].pass_marks ? 'PASSED' : 'FAILED';

        // NEW: Save the result to the database
        await db.query(
            "INSERT INTO results (user_id, exam_id, score, total_questions, status) VALUES (?, ?, ?, ?, ?)",
            [userId, examId, score, totalQuestions, status]
        );

        res.render('student_result', {
            user: req.session.user,
            exam: exam[0],
            score: score,
            total: totalQuestions,
            status: status
        });

    } catch (err) {
        console.error("Submission Error:", err);
        res.status(500).send("Error saving exam result: " + err.message);
    }
});

// Student Profile & Exam History
// Student Profile & Exam History Route
app.get('/student/history', async (req, res) => {
    // 1. Check if user is logged in as a student
    if (!req.session.user || req.session.user.role !== 'student') {
        return res.redirect('/login');
    }

    try {
        const userId = req.session.user.user_id;

        // 2. Fetch this student's specific results joined with exam names
        const [myResults] = await db.query(`
            SELECT r.*, e.exam_name 
            FROM results r
            JOIN exams e ON r.exam_id = e.exam_id
            WHERE r.user_id = ?
            ORDER BY r.submitted_at DESC
        `, [userId]);

        // 3. Render the history page
        res.render('student_history', { 
            user: req.session.user, 
            results: myResults 
        });
    } catch (err) {
        console.error("History Error:", err);
        res.status(500).send("Error loading your history: " + err.message);
    }
});

// the Logging Route here
app.post('/api/monitor/log', async (req, res) => {
    if (!req.session.user) return res.status(401).send("Unauthorized");

    const { examId, eventType, details } = req.body;
    const userId = req.session.user.user_id;

    try {
        await db.query(
            "INSERT INTO monitoring_logs (user_id, exam_id, event_type, event_details) VALUES (?, ?, ?, ?)",
            [userId, examId, eventType, details]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Failed to log event:", err);
        res.status(500).json({ success: false });
    }
});

app.listen(3000, () => {
  console.log(`🚀 Pariksha running on http://localhost:3000`)
})

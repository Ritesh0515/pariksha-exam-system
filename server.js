const express = require('express')
const session = require('express-session')
const db = require('./db')
const multer = require('multer')
const csv = require('csv-parser')
const fs = require('fs')
const upload = multer({ dest: 'uploads/' })
require('dotenv').config()

const app = express()

// 1. Middleware
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.set('view engine', 'ejs')
app.use(express.static('public'))

// 2. Session Setup
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'fallback_secret',
    resave: false,
    saveUninitialized: true,
  }),
)

// Helper: Check for any Administrative/Staff privilege
const isAdmin = (role) => ['super_admin', 'admin', 'staff'].includes(role)

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
    const [users] = await db.query(
      'SELECT * FROM users WHERE email = ? AND password_hash = SHA2(?, 256)',
      [email, password],
    )

    if (users.length > 0) {
      const user = users[0]
      if (user.is_active === 0) {
        return res.redirect('/login?error=inactive')
      }
      req.session.user = user

      // Direct any admin-related role to the Admin Dashboard
      if (isAdmin(user.role)) {
        res.redirect('/admin/dashboard')
      } else {
        res.redirect('/student/dashboard')
      }
    } else {
      res.redirect('/login?error=invalid')
    }
  } catch (err) {
    console.error('Login Error:', err)
    res.redirect('/login?error=server')
  }
})

// --- STUDENT SIGNUP ---

// Signup Page
app.get('/signup', (req, res) => {
  res.render('signup') // Ensure you have views/signup.ejs
})

// Handle Signup
app.post('/signup', async (req, res) => {
  const { first_name, last_name, email, roll_no, class_name, password } =
    req.body
  const username = `${first_name} ${last_name}`

  try {
    const [existing] = await db.query(
      'SELECT user_id FROM users WHERE email = ?',
      [email],
    )
    if (existing.length > 0) {
      return res.redirect('/signup?error=exists') // Trigger warning popup
    }

    const sql = `
      INSERT INTO users (username, first_name, last_name, email, password_hash, role, roll_no, class_name, is_active) 
      VALUES (?, ?, ?, ?, SHA2(?, 256), 'student', ?, ?, 1)
    `
    await db.query(sql, [
      username,
      first_name,
      last_name,
      email,
      password,
      roll_no,
      class_name,
    ])

    res.redirect('/login?registered=true') // Trigger success popup
  } catch (err) {
    console.error('Signup Error:', err)
    res.status(500).send('Registration failed: ' + err.message)
  }
})
// --- ADMIN DASHBOARD ---
app.get('/admin/dashboard', async (req, res) => {
  if (!req.session.user || !isAdmin(req.session.user.role))
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
// --- EXAM MANAGEMENT ---
app.get('/admin/exams', async (req, res) => {
  // Security Check
  if (!req.session.user || !isAdmin(req.session.user.role))
    return res.redirect('/login')

  try {
    // 1. Fetch all courses for the "Smart Selection" dropdown
    const [courses] = await db.query(
      'SELECT * FROM courses ORDER BY course_name ASC',
    )

    // 2. Fetch exams with subject, year, and course names for the table
    const [exams] = await db.query(`
      SELECT e.*, s.subject_name, s.year, c.course_name 
      FROM exams e 
      JOIN subjects s ON e.subject_id = s.subject_id
      JOIN courses c ON s.course_id = c.course_id
      ORDER BY e.exam_id DESC
    `)

    // 3. Render the page and pass BOTH variables
    res.render('admin_exams', {
      user: req.session.user,
      courses: courses, // This fixes the "courses is not defined" error
      exams: exams,
    })
  } catch (err) {
    console.error('Error loading exams:', err)
    res.status(500).send('Error loading exams page')
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

// DELETE EXAM (Updated to clear all dependencies)
app.get('/admin/exams/delete/:id', async (req, res) => {
  try {
    const id = req.params.id
    // Clear all dependencies first
    await db.query('DELETE FROM monitoring_logs WHERE exam_id = ?', [id])
    await db.query('DELETE FROM results WHERE exam_id = ?', [id])
    await db.query('DELETE FROM questions WHERE exam_id = ?', [id])
    await db.query('DELETE FROM exams WHERE exam_id = ?', [id])
    res.redirect('/admin/exams')
  } catch (err) {
    res.status(500).send('Database Error: ' + err.message)
  }
})

// ==========================================
// --- DYNAMIC FILTERING API ---
// ==========================================

// This route provides the data for your "Chained Dropdowns"
app.get('/api/subjects-filter', async (req, res) => {
  const { course_id, year } = req.query
  try {
    const [subjects] = await db.query(
      'SELECT subject_id, subject_name FROM subjects WHERE course_id = ? AND year = ?',
      [course_id, year],
    )
    res.json(subjects)
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch subjects' })
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

// BULK UPLOAD QUESTIONS VIA CSV
app.post(
  '/admin/exams/:examId/questions/upload',
  upload.single('csvFile'),
  async (req, res) => {
    const examId = req.params.examId

    // Safety check for file
    if (!req.file) return res.status(400).send('No file uploaded.')

    const filePath = req.file.path
    const questions = []

    // 1. Parse the CSV file
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        // Mapping CSV headers to Database columns
        // Ensure your CSV has headers: text, a, b, c, d, correct
        questions.push([
          examId,
          row.text,
          row.a,
          row.b,
          row.c,
          row.d,
          row.correct,
        ])
      })
      .on('end', async () => {
        try {
          if (questions.length > 0) {
            // 2. Perform Bulk Insert
            const query = `INSERT INTO questions (exam_id, question_text, option_a, option_b, option_c, option_d, correct_answer) VALUES ?`
            await db.query(query, [questions])
          }

          // 3. Clean up: Delete the temporary file
          fs.unlinkSync(filePath)
          res.redirect(`/admin/exams/${examId}/questions`)
        } catch (err) {
          console.error('Bulk Upload Error:', err)
          res.status(500).send('Error saving bulk questions: ' + err.message)
        }
      })
  },
)

// DELETE SINGLE QUESTION
app.get('/admin/questions/delete/:examId/:questionId', async (req, res) => {
  try {
    await db.query('DELETE FROM questions WHERE question_id = ?', [
      req.params.questionId,
    ])
    res.redirect(`/admin/exams/${req.params.examId}/questions`)
  } catch (err) {
    res.status(500).send('Error deleting question: ' + err.message)
  }
})

// DELETE ALL QUESTIONS FOR AN EXAM
app.get('/admin/questions/delete-all/:examId', async (req, res) => {
  try {
    await db.query('DELETE FROM questions WHERE exam_id = ?', [
      req.params.examId,
    ])
    res.redirect(`/admin/exams/${req.params.examId}/questions`)
  } catch (err) {
    res.status(500).send('Error clearing question bank: ' + err.message)
  }
})

// UPDATE SINGLE QUESTION
app.post('/admin/questions/update/:examId/:questionId', async (req, res) => {
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
      'UPDATE questions SET question_text=?, option_a=?, option_b=?, option_c=?, option_d=?, correct_answer=? WHERE question_id=?',
      [
        question_text,
        option_a,
        option_b,
        option_c,
        option_d,
        correct_answer,
        req.params.questionId,
      ],
    )
    res.redirect(`/admin/exams/${req.params.examId}/questions`)
  } catch (err) {
    res.status(500).send('Error updating question: ' + err.message)
  }
})

// ==========================================
// --- COURSE MANAGEMENT ---
// ==========================================

// 1. Get All Courses
app.get('/admin/courses', async (req, res) => {
  if (!req.session.user || !isAdmin(req.session.user.role))
    return res.redirect('/login')
  try {
    const [courses] = await db.query(
      'SELECT * FROM courses ORDER BY course_name ASC',
    )
    res.render('admin_courses', {
      user: req.session.user,
      courses,
      currentPage: 'courses',
    })
  } catch (err) {
    console.error('Course Load Error:', err)
    res.status(500).send('Error loading courses')
  }
})

// 2. Add New Course (BBA, BBA-CA, MBA, etc.)
app.post('/admin/courses/add', async (req, res) => {
  const { course_name } = req.body
  try {
    await db.query('INSERT INTO courses (course_name) VALUES (?)', [
      course_name,
    ])
    res.redirect('/admin/courses')
  } catch (err) {
    console.error('Add Course Error:', err)
    res.status(500).send('Error adding course. Ensure the name is unique.')
  }
})

// 3. Delete Course
app.get('/admin/courses/delete/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM courses WHERE course_id = ?', [req.params.id])
    res.redirect('/admin/courses')
  } catch (err) {
    res
      .status(500)
      .send('Cannot delete course. It might have subjects linked to it.')
  }
})

// ==========================================
// --- STAFF MANAGEMENT ---
// ==========================================

// 1. List all Admin staff
app.get('/admin/staff', async (req, res) => {
  // Only logged-in admins can access this page
  if (!req.session.user || !isAdmin(req.session.user.role))
    return res.redirect('/login')

  try {
    // Fetch specific columns for security (never fetch raw password_hash here)
    const [admins] = await db.query(
      "SELECT user_id, username, email, is_active FROM users WHERE role = 'admin'",
    )
    res.render('admin_staff', {
      user: req.session.user,
      admins,
      currentPage: 'staff',
    })
  } catch (err) {
    console.error('Staff Load Error:', err)
    res.status(500).send('Error loading staff page')
  }
})

// 2. Add a new Admin securely
app.post('/admin/staff/add', async (req, res) => {
  const { first_name, last_name, email, password, role } = req.body // Added role
  const username = `${first_name} ${last_name}`

  try {
    const [existing] = await db.query(
      'SELECT user_id FROM users WHERE email = ?',
      [email],
    )
    if (existing.length > 0) return res.redirect('/admin/staff?error=conflict')

    await db.query(
      'INSERT INTO users (username, first_name, last_name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, SHA2(?, 256), ?, 1)',
      [username, first_name, last_name, email, password, role], // Insert chosen role
    )

    res.redirect('/admin/staff?success=added')
  } catch (err) {
    res.redirect('/admin/staff?error=server')
  }
})

// Toggle Staff Active Status
app.get('/admin/staff/toggle-status/:id', async (req, res) => {
  // Only Super Admins should be able to disable other staff
  if (!req.session.user || req.session.user.role !== 'super_admin') {
    return res
      .status(403)
      .send('Unauthorized: Only Super Admins can manage staff status.')
  }

  try {
    const staffId = req.params.id

    // Prevent Super Admin from deactivating themselves
    if (staffId == req.session.user.user_id) {
      return res.redirect('/admin/staff?error=self_deactivate')
    }

    // Toggle the is_active bit (1 to 0 or 0 to 1)
    await db.query(
      'UPDATE users SET is_active = NOT is_active WHERE user_id = ?',
      [staffId],
    )

    res.redirect('/admin/staff?success=status_updated')
  } catch (err) {
    console.error('Toggle Status Error:', err)
    res.status(500).send('Internal Server Error')
  }
})

// --- SUBJECT MANAGEMENT ---
app.get('/admin/subjects', async (req, res) => {
  const selectedCourse = req.query.course || '' // Catch the filter from the URL
  try {
    const [courses] = await db.query('SELECT * FROM courses')

    // Updated SQL to filter if a course is selected
    let sql =
      'SELECT s.*, c.course_name FROM subjects s JOIN courses c ON s.course_id = c.course_id'
    let params = []

    if (selectedCourse) {
      sql += ' WHERE s.course_id = ?'
      params.push(selectedCourse)
    }

    const [subjects] = await db.query(sql, params)
    res.render('admin_subjects', {
      user: req.session.user,
      courses,
      subjects,
      selectedCourse,
    })
  } catch (err) {
    res.status(500).send('Error loading subjects')
  }
})

app.post('/admin/subjects/add', async (req, res) => {
  const { subject_name, subject_code, course_id, year } = req.body // Catch the year
  try {
    await db.query(
      'INSERT INTO subjects (subject_name, subject_code, course_id, year, created_by) VALUES (?, ?, ?, ?, ?)',
      [subject_name, subject_code, course_id, year, req.session.user.user_id],
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
  if (!req.session.user || !isAdmin(req.session.user.role)) {
    return res.redirect('/login')
  }

  try {
    // 2. Fetch the results joined with academic details (Roll No & Class)
    const [allResults] = await db.query(`
            SELECT r.*, u.first_name, u.last_name, u.roll_no, u.class_name, e.exam_name 
            FROM results r
            JOIN users u ON r.user_id = u.user_id
            JOIN exams e ON r.exam_id = e.exam_id
            ORDER BY r.submitted_at DESC
        `)

    // 3. Render the page and send the data
    res.render('admin_results', {
      user: req.session.user,
      results: allResults,
      currentPage: 'results',
    })
  } catch (err) {
    console.error('Error fetching results:', err)
    res.status(500).send('Error loading results page: ' + err.message)
  }
})

// ==========================================
// STUDENT ROUTES
// ==========================================

// Student Dashboard - Show available exams
app.get('/student/dashboard', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') {
    return res.redirect('/login')
  }

  try {
    // Fetch all exams joined with their subject names
    const [exams] = await db.query(`
            SELECT e.*, s.subject_name 
            FROM exams e 
            JOIN subjects s ON e.subject_id = s.subject_id
        `)

    res.render('student_dashboard', {
      user: req.session.user,
      exams: exams,
      activeExamId: req.session.currentExamId || null,
    })
  } catch (err) {
    console.error('Student Dashboard SQL Error:', err)
    res.status(500).send('Error loading student dashboard: ' + err.message)
  }
})

// Route to show instructions before starting
app.get('/student/exam/:examId/start', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') {
    return res.redirect('/login')
  }

  try {
    const examId = req.params.examId
    const userId = req.session.user.user_id

    // 1. One-Attempt Restriction
    const [existing] = await db.query(
      'SELECT result_id FROM results WHERE user_id = ? AND exam_id = ?',
      [userId, examId],
    )
    if (existing.length > 0) return res.redirect('/student/history')

    // 2. Fetch Exam Data with Subject Name
    const [exam] = await db.query(
      'SELECT e.*, s.subject_name FROM exams e JOIN subjects s ON e.subject_id = s.subject_id WHERE e.exam_id = ?',
      [examId],
    )

    // 3. Get Question Count
    const [[{ qCount }]] = await db.query(
      'SELECT COUNT(*) as qCount FROM questions WHERE exam_id = ?',
      [examId],
    )

    // 4. Render the Instructions Page (Not the exam yet!)
    res.render('student_exam_start', {
      user: req.session.user,
      exam: exam[0],
      qCount: qCount,
    })
  } catch (err) {
    res.status(500).send('Error: ' + err.message)
  }
})

// Route to show the actual questions (The Attempt Page)
app.get('/student/exam/:examId/attempt', async (req, res) => {
  // 1. Security Check: Are they logged in as a student?
  if (!req.session.user || req.session.user.role !== 'student') {
    return res.redirect('/login')
  }

  try {
    const examId = req.params.examId
    const userId = req.session.user.user_id

    // 2. ONE-ATTEMPT RESTRICTION
    const [existingResult] = await db.query(
      'SELECT result_id FROM results WHERE user_id = ? AND exam_id = ?',
      [userId, examId],
    )

    if (existingResult.length > 0) {
      return res.redirect('/student/history')
    }

    // 3. Fetch exam details
    const [exam] = await db.query('SELECT * FROM exams WHERE exam_id = ?', [
      examId,
    ])

    // 4. Fetch all questions
    const [questions] = await db.query(
      'SELECT * FROM questions WHERE exam_id = ?',
      [examId],
    )

    // --- NEW: PERSISTENT TIMER LOGIC ---
    // If there is no end time in the session, or if the student switched to a different exam
    if (!req.session.examEndTime || req.session.currentExamId !== examId) {
      const durationInMs = exam[0].duration_minutes * 60 * 1000
      req.session.examEndTime = Date.now() + durationInMs
      req.session.currentExamId = examId
    }

    // Calculate how many seconds are left
    const remainingSeconds = Math.max(
      0,
      Math.floor((req.session.examEndTime - Date.now()) / 1000),
    )

    // 5. Render the page with the timer data
    res.render('student_exam_attempt', {
      user: req.session.user,
      exam: exam[0],
      questions: questions,
      remainingSeconds: remainingSeconds, // PASS THIS TO THE EJS
    })
  } catch (err) {
    console.error('Exam Attempt Error:', err)
    res.status(500).send('Error starting exam attempt: ' + err.message)
  }
})

app.post('/student/exam/:examId/submit', async (req, res) => {
  const examId = req.params.examId
  const studentAnswers = req.body
  const userId = req.session.user.user_id // Get the ID of the logged-in student

  try {
    const [questions] = await db.query(
      'SELECT question_id, correct_answer FROM questions WHERE exam_id = ?',
      [examId],
    )
    const [exam] = await db.query('SELECT * FROM exams WHERE exam_id = ?', [
      examId,
    ])

    let score = 0
    const totalQuestions = questions.length

    questions.forEach((q) => {
      const studentSelection = studentAnswers[`q${q.question_id}`]
      if (studentSelection === q.correct_answer) {
        score++
      }
    })

    const status = score >= exam[0].pass_marks ? 'PASSED' : 'FAILED'

    // NEW: Save the result to the database
    await db.query(
      'INSERT INTO results (user_id, exam_id, score, total_questions, status) VALUES (?, ?, ?, ?, ?)',
      [userId, examId, score, totalQuestions, status],
    )

    delete req.session.examEndTime
    delete req.session.currentExamId

    res.render('student_result', {
      user: req.session.user,
      exam: exam[0],
      score: score,
      total: totalQuestions,
      status: status,
    })
  } catch (err) {
    console.error('Submission Error:', err)
    res.status(500).send('Error saving exam result: ' + err.message)
  }
})

// Student Profile & Exam History
// Student Profile & Exam History Route
app.get('/student/history', async (req, res) => {
  // 1. Check if user is logged in as a student
  if (!req.session.user || req.session.user.role !== 'student') {
    return res.redirect('/login')
  }

  try {
    const userId = req.session.user.user_id

    // 2. Fetch this student's specific results joined with exam names
    const [myResults] = await db.query(
      `
            SELECT r.*, e.exam_name 
            FROM results r
            JOIN exams e ON r.exam_id = e.exam_id
            WHERE r.user_id = ?
            ORDER BY r.submitted_at DESC
        `,
      [userId],
    )

    // 3. Render the history page
    res.render('student_history', {
      user: req.session.user,
      results: myResults,
    })
  } catch (err) {
    console.error('History Error:', err)
    res.status(500).send('Error loading your history: ' + err.message)
  }
})

// the Logging Route here
app.post('/api/monitor/log', async (req, res) => {
  if (!req.session.user) return res.status(401).send('Unauthorized')

  const { examId, eventType, details } = req.body
  const userId = req.session.user.user_id

  try {
    await db.query(
      'INSERT INTO monitoring_logs (user_id, exam_id, event_type, event_details) VALUES (?, ?, ?, ?)',
      [userId, examId, eventType, details],
    )
    res.json({ success: true })
  } catch (err) {
    console.error('Failed to log event:', err)
    res.status(500).json({ success: false })
  }
})

// Add this at the very bottom of your student routes
app.get('/student/exam/quit', (req, res) => {
  delete req.session.examEndTime
  delete req.session.currentExamId
  res.redirect('/student/dashboard')
})

app.listen(3000, () => {
  console.log(`🚀 Pariksha running on http://localhost:3000`)
})

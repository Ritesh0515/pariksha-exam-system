const express = require('express')
const session = require('express-session')
const db = require('./db')
const multer = require('multer')
const csv = require('csv-parser')
const fs = require('fs')
const upload = multer({ dest: 'uploads/' })

// Profile Picture Upload Configuration
const profilePicStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = 'public/uploads/profile_pics/'
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    cb(null, dir)
  },
  filename: function (req, file, cb) {
    cb(null, 'profile-' + req.session.user.user_id + '.jpg')
  },
})
const uploadProfilePic = multer({ storage: profilePicStorage })
require('dotenv').config()

const app = express()

let hasResultsQuestionSetColumn = false
let examSetAssignmentsSetColumn = 'question_set'

const ensureExamEnhancementSchema = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS exam_set_assignments (
        assignment_id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        exam_id INT NOT NULL,
        question_set VARCHAR(10) NOT NULL DEFAULT 'A',
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_exam (user_id, exam_id)
      )
    `)

    // Backwards-compat: older deployments used `assigned_set` instead of `question_set`
    const [esaQuestionSetCol] = await db.query(
      "SHOW COLUMNS FROM exam_set_assignments LIKE 'question_set'",
    )
    const [esaAssignedSetCol] = await db.query(
      "SHOW COLUMNS FROM exam_set_assignments LIKE 'assigned_set'",
    )

    if (esaQuestionSetCol.length === 0 && esaAssignedSetCol.length > 0) {
      await db.query(
        "ALTER TABLE exam_set_assignments CHANGE COLUMN assigned_set question_set VARCHAR(10) NOT NULL DEFAULT 'A'",
      )
      examSetAssignmentsSetColumn = 'question_set'
    } else if (esaQuestionSetCol.length === 0 && esaAssignedSetCol.length === 0) {
      await db.query(
        "ALTER TABLE exam_set_assignments ADD COLUMN question_set VARCHAR(10) NOT NULL DEFAULT 'A'",
      )
      examSetAssignmentsSetColumn = 'question_set'
    } else {
      examSetAssignmentsSetColumn = 'question_set'
    }

    const [questionSetColumn] = await db.query(
      "SHOW COLUMNS FROM questions LIKE 'question_set'",
    )
    if (questionSetColumn.length === 0) {
      await db.query(
        "ALTER TABLE questions ADD COLUMN question_set VARCHAR(10) NOT NULL DEFAULT 'A'",
      )
    }

    const [resultSetColumn] = await db.query(
      "SHOW COLUMNS FROM results LIKE 'question_set'",
    )
    if (resultSetColumn.length === 0) {
      await db.query(
        'ALTER TABLE results ADD COLUMN question_set VARCHAR(10) NULL DEFAULT NULL',
      )
      hasResultsQuestionSetColumn = true
    } else {
      hasResultsQuestionSetColumn = true
    }
  } catch (err) {
    console.error('Schema enhancement warning:', err.message)
  }
}

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
const isAdmin = (role) => ['admin', 'staff'].includes(role)

// 3. ROUTES

// Root Route
app.get('/', (req, res) => {
  res.render('index')
})

// Login Page
app.get('/login', (req, res) => {
  res.render('login')
})

// Dedicated faculty entry point (shared auth view)
app.get('/admin/login', (req, res) => {
  res.redirect('/login')
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
// Updated Signup Route to fetch courses
app.get('/signup', async (req, res) => {
  try {
    const [courses] = await db.query(
      'SELECT course_name FROM courses ORDER BY course_name ASC',
    )
    res.render('signup', { courses: courses }) // Pass the courses to the EJS file
  } catch (err) {
    console.error('Error fetching courses for signup:', err)
    res.render('signup', { courses: [] }) // Fallback to empty list if error
  }
})
// Handle Signup
app.post('/signup', async (req, res) => {
  const { first_name, last_name, email, class_name, password, year_code } =
    req.body
  const username = `${first_name} ${last_name}`

  try {
    const [existing] = await db.query(
      'SELECT user_id FROM users WHERE email = ?',
      [email],
    )
    if (existing.length > 0) return res.redirect('/signup?error=exists')

    const sql = `
            INSERT INTO users (username, first_name, last_name, email, password_hash, role, class_name, year_code, is_active) 
            VALUES (?, ?, ?, ?, SHA2(?, 256), 'student', ?, ?, 1)
        `

    // Capture the result to get the new student's ID
    const [result] = await db.query(sql, [
      username,
      first_name,
      last_name,
      email,
      password,
      class_name,
      year_code,
    ])

    // --- NEW: CREATE NOTIFICATION FOR ADMIN ---
    const newStudentId = result.insertId
    const adminMessage = `New student ${first_name} ${last_name} has registered under the course ${class_name} (${year_code}). Action: Assign Roll Number.`

    await db.query(
      'INSERT INTO notifications (user_id, message) VALUES (?, ?)',
      [newStudentId, adminMessage],
    )

    res.redirect('/login?registered=true')
  } catch (err) {
    console.error('Signup Error:', err)
    res.status(500).send('Registration failed')
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

    // --- NEW: FETCH UNREAD NOTIFICATIONS ---
    const [notifications] = await db.query(
      'SELECT * FROM notifications WHERE is_read = 0 ORDER BY created_at DESC',
    )

    res.render('admin_dashboard', {
      user: req.session.user,
      stats: {
        exams: examCount || 0,
        subjects: subjectCount || 0,
        students: studentCount || 0,
      },
      activities: recentSubjects,
      notifications: notifications, // Pass notifications to the EJS
      currentPage: 'dashboard',
    })
  } catch (err) {
    console.error('Dashboard Error:', err)
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
  // 1. Extract the new scheduling fields from req.body
  const {
    subject_id,
    exam_name,
    duration_minutes,
    total_marks,
    pass_marks,
    start_time,
    end_time,
  } = req.body

  try {
    // 2. Updated SQL to include start_time and end_time
    // Note: I changed status to 'active' so students can actually see it
    // when the clock hits the start_time.
    const query = `
      INSERT INTO exams 
      (subject_id, exam_name, duration_minutes, total_marks, pass_marks, start_time, end_time, status) 
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `

    await db.query(query, [
      subject_id,
      exam_name,
      duration_minutes,
      total_marks,
      pass_marks,
      start_time || null, // Safety: converts empty string to NULL
      end_time || null, // Safety: converts empty string to NULL
    ])

    res.redirect('/admin/exams')
  } catch (err) {
    console.error('Error creating exam:', err)
    res.status(500).send('Error creating exam: ' + err.message)
  }
})

app.post('/admin/exams/update/:id', async (req, res) => {
  const examId = req.params.id

  // 1. Extract name, stats, AND the new time windows
  const {
    exam_name,
    duration_minutes,
    total_marks,
    pass_marks,
    start_time,
    end_time,
  } = req.body

  try {
    // 2. Updated SQL query with the new columns
    const query = `
      UPDATE exams 
      SET exam_name = ?, 
          duration_minutes = ?, 
          total_marks = ?, 
          pass_marks = ?, 
          start_time = ?, 
          end_time = ? 
      WHERE exam_id = ?
    `

    await db.query(query, [
      exam_name,
      duration_minutes,
      total_marks,
      pass_marks,
      start_time || null, // Handles clearing dates
      end_time || null, // Handles clearing dates
      examId,
    ])

    res.redirect('/admin/exams?success=updated')
  } catch (err) {
    console.error('Update Exam Error:', err)
    res.status(500).send('Update failed: ' + err.message)
  }
})

// DELETE EXAM (Updated to clear all dependencies)
app.get('/admin/exams/delete/:id', async (req, res) => {
  // Security: Only Admins and Super Admins can delete
  if (!req.session.user || req.session.user.role !== 'admin') {
    // Redirect back with an error code instead of showing a white page
    return res.redirect('/admin/exams?error=unauthorized')
  }

  try {
    const id = req.params.id
    // We removed the line that deletes results to keep your data safe!
    await db.query('DELETE FROM monitoring_logs WHERE exam_id = ?', [id])
    await db.query('DELETE FROM questions WHERE exam_id = ?', [id])
    await db.query('DELETE FROM exams WHERE exam_id = ?', [id])

    res.redirect('/admin/exams?success=deleted')
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

// 1. VIEW QUESTIONS (Optimized with Set Sorting)
app.get('/admin/exams/:examId/questions', async (req, res) => {
  if (!req.session.user || !isAdmin(req.session.user.role)) {
    return res.redirect('/login')
  }

  try {
    const [exam] = await db.query('SELECT * FROM exams WHERE exam_id = ?', [
      req.params.examId,
    ])

    // Sorted by Set then ID so Admin sees Set A and Set B grouped together
    const [questions] = await db.query(
      'SELECT * FROM questions WHERE exam_id = ? ORDER BY question_set ASC, question_id ASC',
      [req.params.examId],
    )

    res.render('admin_questions', {
      exam: exam[0],
      questions: questions,
      user: req.session.user,
    })
  } catch (err) {
    console.error(err)
    res.status(500).send('Error loading questions')
  }
})

// 2. ADD SINGLE QUESTION (With Set Support)
app.post('/admin/exams/:examId/questions/add', async (req, res) => {
  const {
    question_text,
    option_a,
    option_b,
    option_c,
    option_d,
    correct_answer,
    question_set,
  } = req.body
  try {
    await db.query(
      'INSERT INTO questions (exam_id, question_text, option_a, option_b, option_c, option_d, correct_answer, question_set) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        req.params.examId,
        question_text.trim(),
        option_a.trim(),
        option_b.trim(),
        option_c.trim(),
        option_d.trim(),
        correct_answer,
        (question_set || 'A').toUpperCase(),
      ],
    )
    res.redirect(`/admin/exams/${req.params.examId}/questions`)
  } catch (err) {
    res.status(500).send('Error saving question')
  }
})

// 3. BULK UPLOAD (Enhanced mapping & Manual Set Override)
app.post(
  '/admin/exams/:examId/questions/upload',
  upload.single('csvFile'),
  async (req, res) => {
    const examId = req.params.examId
    const defaultSetSelection = req.body.default_set // Catch the choice from the dropdown

    if (!req.file) return res.status(400).send('No file uploaded.')

    const filePath = req.file.path
    const questions = []

    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        let assignedSet

        // LOGIC: If 'OVERRIDE' is selected, look at CSV columns.
        // Otherwise, force all questions to the selected Set (A or B).
        if (defaultSetSelection === 'OVERRIDE') {
          assignedSet = (
            row.set ||
            row.question_set ||
            row.group ||
            'A'
          ).toUpperCase()
        } else {
          assignedSet = (defaultSetSelection || 'A').toUpperCase()
        }

        // Basic validation: skip empty rows
        if (row.text || row.question_text) {
          questions.push([
            examId,
            (row.text || row.question_text).trim(),
            (row.a || row.option_a).trim(),
            (row.b || row.option_b).trim(),
            (row.c || row.option_c).trim(),
            (row.d || row.option_d).trim(),
            (row.correct || row.correct_answer).toLowerCase(),
            assignedSet,
          ])
        }
      })
      .on('end', async () => {
        try {
          if (questions.length > 0) {
            const query = `INSERT INTO questions (exam_id, question_text, option_a, option_b, option_c, option_d, correct_answer, question_set) VALUES ?`
            await db.query(query, [questions])
          }

          // Clean up the uploaded file
          fs.unlinkSync(filePath)
          res.redirect(`/admin/exams/${examId}/questions`)
        } catch (err) {
          console.error('Bulk Upload Database Error:', err)
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
          res.status(500).send('Bulk Upload Error: ' + err.message)
        }
      })
  },
)

// 4. DUPLICATE DETECTOR (Backend API)
// You can call this via fetch() from your "Check Duplicates" button
app.get('/api/admin/exams/:examId/duplicates', async (req, res) => {
  try {
    const query = `
      SELECT question_text, COUNT(*) as count 
      FROM questions 
      WHERE exam_id = ? 
      GROUP BY question_text 
      HAVING count > 1`

    const [duplicates] = await db.query(query, [req.params.examId])
    res.json({ duplicates })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Add this in your QUESTION MANAGEMENT section
app.post('/api/admin/exams/:examId/duplicates/cleanup', async (req, res) => {
  try {
    const examId = req.params.examId
    const query = `
      DELETE q1 FROM questions q1
      INNER JOIN questions q2 
      WHERE q1.question_id > q2.question_id 
      AND q1.question_text = q2.question_text 
      AND q1.exam_id = ?`

    const [result] = await db.query(query, [examId])
    res.json({ deletedCount: result.affectedRows })
  } catch (err) {
    console.error('SQL Error:', err)
    res.status(500).json({ error: err.message })
  }
})

// 5. UPDATE QUESTION
app.post('/admin/questions/update/:examId/:questionId', async (req, res) => {
  const {
    question_text,
    option_a,
    option_b,
    option_c,
    option_d,
    correct_answer,
    question_set,
  } = req.body
  try {
    await db.query(
      'UPDATE questions SET question_text=?, option_a=?, option_b=?, option_c=?, option_d=?, correct_answer=?, question_set=? WHERE question_id=?',
      [
        question_text.trim(),
        option_a.trim(),
        option_b.trim(),
        option_c.trim(),
        option_d.trim(),
        correct_answer,
        (question_set || 'A').toUpperCase(),
        req.params.questionId,
      ],
    )
    res.redirect(`/admin/exams/${req.params.examId}/questions`)
  } catch (err) {
    res.status(500).send('Error updating question')
  }
})

// 6. DELETE ROUTE (Single)
app.get('/admin/questions/delete/:examId/:questionId', async (req, res) => {
  try {
    await db.query('DELETE FROM questions WHERE question_id = ?', [
      req.params.questionId,
    ])
    res.redirect(`/admin/exams/${req.params.examId}/questions`)
  } catch (err) {
    res.status(500).send('Error deleting question')
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
  if (req.session.user.role === 'staff')
    return res.status(403).send('Unauthorized: Staff cannot add courses.')
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
  if (req.session.user.role === 'staff')
    return res.status(403).send('Unauthorized: Staff cannot delete courses.')
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
  if (!req.session.user || !isAdmin(req.session.user.role))
    return res.redirect('/login')

  try {
    // Change this line to include all administrative roles
    const [admins] = await db.query(
      "SELECT user_id, username, email, role, is_active FROM users WHERE role IN ('super_admin', 'admin', 'staff')",
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
  if (!req.session.user || req.session.user.role !== 'admin') {
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
  if (!req.session.user || req.session.user.role === 'staff') {
    return res.status(403).send('Unauthorized: Staff cannot add subjects.')
  }
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
  if (!req.session.user || req.session.user.role === 'staff') {
    return res.status(403).send('Unauthorized: Staff cannot edit subjects.')
  }
  if (!req.session.user || !isAdmin(req.session.user.role))
    return res.redirect('/login')

  const { subject_name, subject_code, course_id, year } = req.body // Added year
  try {
    await db.query(
      'UPDATE subjects SET subject_name=?, subject_code=?, course_id=?, year=? WHERE subject_id=?',
      [subject_name, subject_code, course_id, year, req.params.id], // Added year to SQL
    )
    res.redirect('/admin/subjects')
  } catch (err) {
    console.error('Subject Update Error:', err)
    res.status(500).send('Error updating subject')
  }
})

app.get('/admin/subjects/delete/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role === 'staff') {
    return res.status(403).send('Unauthorized: Staff cannot delete subjects.')
  }
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
  // 1. Security check
  if (!req.session.user || !isAdmin(req.session.user.role)) {
    return res.redirect('/login')
  }

  try {
    const { examId, courseId, year } = req.query

    // Variables to pass to EJS
    let exam = null
    let exams = []
    let allResults = []
    let currentCourseName = null
    let currentCourseId = null

    // 2. Fetch all courses for the initial selection cards
    const [courses] = await db.query(
      'SELECT * FROM courses ORDER BY course_name ASC',
    )

    // 3. Get context if courseId is present (Fixes the breadcrumb "Memory")
    if (courseId) {
      const [courseData] = await db.query(
        'SELECT * FROM courses WHERE course_id = ?',
        [courseId],
      )
      if (courseData.length > 0) {
        currentCourseId = String(courseData[0].course_id)
        currentCourseName = courseData[0].course_name
      }
    }

    // --- STATE: VIEWING SPECIFIC EXAM RESULTS (Marksheet Mode) ---
    if (examId) {
      // Fetch specific exam details
      const [examData] = await db.query(
        `SELECT e.*, s.subject_name, s.course_id, s.year 
         FROM exams e 
         JOIN subjects s ON e.subject_id = s.subject_id 
         WHERE e.exam_id = ?`,
        [examId]
      )

      if (examData.length > 0) {
        exam = examData[0]

        // Ensure breadcrumb + links remain stable even if user opened by examId only
        if (!currentCourseId) currentCourseId = String(exam.course_id)
        if (!currentCourseName) {
          const [courseData2] = await db.query(
            'SELECT course_name FROM courses WHERE course_id = ? LIMIT 1',
            [currentCourseId],
          )
          if (courseData2.length > 0) currentCourseName = courseData2[0].course_name
        }
        
        // Fetch ALL students in this course/year + their results (LEFT JOIN)
        // This ensures students with NO attempts show up for the "Grant Access" button
        const [resultsData] = await db.query(`
          SELECT 
            u.user_id, u.roll_no, u.first_name, u.last_name,
            r.score as marks_obtained, r.total_questions, r.status, r.submitted_at,
            COALESCE(r.question_set, esa.question_set) AS question_set,
            esa.question_set AS assigned_question_set
          FROM users u
          LEFT JOIN results r ON u.user_id = r.user_id AND r.exam_id = ?
          LEFT JOIN exam_set_assignments esa ON u.user_id = esa.user_id AND esa.exam_id = ?
          WHERE u.class_name = ? AND u.year_code = ? AND u.role = 'student'
          ORDER BY u.roll_no ASC`, 
          [examId, examId, currentCourseName, exam.year]
        )
        allResults = resultsData
      }
    } 
    // --- STATE: LISTING EXAMS (Selection Mode) ---
    else if (courseId && year) {
      const examsQuery = `
        SELECT e.*, s.subject_name 
        FROM exams e 
        JOIN subjects s ON e.subject_id = s.subject_id 
        WHERE s.course_id = ? AND s.year = ?
        ORDER BY e.exam_id DESC`;
      
      const [examsData] = await db.query(examsQuery, [courseId, year])
      exams = examsData
    }

    // 4. Render with consistent variable names
    res.render('admin_results', {
      user: req.session.user,
      results: allResults,    // List of students for the table
      courses: courses,       // List of courses for the sidebar/cards
      exams: exams,           // List of exam cards
      exam: exam,             // The specific exam being viewed
      currentCourseId: currentCourseId, // raw id for hrefs
      currentCourse: currentCourseName, // display name for breadcrumbs/text
      currentYear: year || (exam ? exam.year : null), // FY/SY/TY
      currentPage: 'results'
    });

  } catch (err) {
    console.error('Error fetching results:', err)
    res
      .status(500)
      .send(
        'Error loading results page: ' +
          (err?.sqlMessage || err?.message || 'Unknown error'),
      )
  }
});

app.get('/api/admin/results-analytics', async (req, res) => {
  if (!req.session.user || !isAdmin(req.session.user.role)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { class_name, year_code, exam_name } = req.query
  if (!class_name || !year_code || !exam_name) {
    return res
      .status(400)
      .json({ error: 'class_name, year_code and exam_name are required' })
  }

  try {
    const [rows] = await db.query(
      `SELECT r.score, r.total_questions, r.status, COALESCE(r.question_set, 'A') AS question_set
       FROM results r
       JOIN exams e ON r.exam_id = e.exam_id
       JOIN users u ON r.user_id = u.user_id
       WHERE u.class_name = ? AND u.year_code = ? AND e.exam_name = ?`,
      [class_name, year_code, exam_name],
    )

    const totalAttempts = rows.length
    const passedCount = rows.filter((r) => r.status === 'PASSED').length
    const failedCount = totalAttempts - passedCount
    const passRatio = totalAttempts ? (passedCount / totalAttempts) * 100 : 0
    const failRatio = totalAttempts ? (failedCount / totalAttempts) * 100 : 0
    const averageScorePercent = totalAttempts
      ? rows.reduce(
          (sum, r) =>
            sum +
            (Number(r.score) / Math.max(1, Number(r.total_questions))) * 100,
          0,
        ) / totalAttempts
      : 0
    const setACount = rows.filter((r) => r.question_set === 'A').length
    const setBCount = rows.filter((r) => r.question_set === 'B').length

    res.json({
      totalAttempts,
      passedCount,
      failedCount,
      passRatio: Number(passRatio.toFixed(2)),
      failRatio: Number(failRatio.toFixed(2)),
      averageScorePercent: Number(averageScorePercent.toFixed(2)),
      setACount,
      setBCount,
    })
  } catch (err) {
    console.error('Results analytics API error:', err)
    res.status(500).json({ error: 'Failed to fetch analytics' })
  }
})

// ==========================================
// STUDENT ROUTES
// ==========================================

// Student Dashboard - Show available exams
app.get('/student/dashboard', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student')
    return res.redirect('/login')

  try {
    const userId = req.session.user.user_id

    // ADDED 'roll_no' TO THE SELECT QUERY BELOW
    const [[user]] = await db.query(
      'SELECT first_name, last_name, class_name, year_code, profile_pic, roll_no FROM users WHERE user_id = ?',
      [userId],
    )

    // 2. Fetch exams ONLY if they belong to this student's Course and Year
    const [exams] = await db.query(
      `
            SELECT e.*, s.subject_name 
            FROM exams e 
            JOIN subjects s ON e.subject_id = s.subject_id
            JOIN courses c ON s.course_id = c.course_id
            WHERE c.course_name = ? AND s.year = ?
        `,
      [user.class_name, user.year_code],
    )

    res.render('student_dashboard', {
      user: user, // Now includes roll_no
      exams: exams,
      activeExamId: req.session.currentExamId || null,
    })
  } catch (err) {
    console.error('Dashboard Error:', err)
    res.status(500).send('Internal Server Error')
  }
})

// Handle student profile photo upload
app.post(
  '/student/upload-profile',
  uploadProfilePic.single('profile_pic'),
  async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'student') {
      return res.redirect('/login')
    }

    try {
      const studentId = req.session.user.user_id
      const profilePicFileName = req.file ? req.file.filename : null

      if (!profilePicFileName) {
        return res.redirect('/student/dashboard?error=no_file')
      }

      await db.query('UPDATE users SET profile_pic = ? WHERE user_id = ?', [
        profilePicFileName,
        studentId,
      ])

      // Refresh session so UI can immediately reflect uploaded image
      req.session.user.profile_pic = profilePicFileName

      res.redirect('/student/dashboard?success=profile_updated')
    } catch (err) {
      console.error('Profile Upload Error:', err)
      res.status(500).send('Error uploading profile picture')
    }
  },
)

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

    const [setAvailability] = await db.query(
      'SELECT question_set, COUNT(*) AS total FROM questions WHERE exam_id = ? GROUP BY question_set',
      [examId],
    )
    const availableSets = setAvailability.map((row) => row.question_set)
    const normalizedAvailableSets =
      availableSets.length > 0 ? availableSets : ['A']

    let assignedSet = normalizedAvailableSets[0]
    const [existingAssignment] = await db.query(
      'SELECT question_set FROM exam_set_assignments WHERE user_id = ? AND exam_id = ? LIMIT 1',
      [userId, examId],
    )

    if (existingAssignment.length > 0) {
      assignedSet = existingAssignment[0].question_set
    } else {
      const [assignmentLoad] = await db.query(
        `SELECT question_set, COUNT(*) AS assignedCount
         FROM exam_set_assignments
         WHERE exam_id = ?
         GROUP BY question_set`,
        [examId],
      )
      const loadMap = {}
      assignmentLoad.forEach((row) => {
        loadMap[row.question_set] = Number(row.assignedCount || 0)
      })
      assignedSet = normalizedAvailableSets.reduce((bestSet, currentSet) => {
        const currentLoad = loadMap[currentSet] ?? 0
        const bestLoad = loadMap[bestSet] ?? 0
        return currentLoad < bestLoad ? currentSet : bestSet
      }, normalizedAvailableSets[0])

      await db.query(
        'INSERT INTO exam_set_assignments (user_id, exam_id, question_set) VALUES (?, ?, ?)',
        [userId, examId, assignedSet],
      )
    }

    // 4. Render the Instructions Page (Not the exam yet!)
    res.render('student_exam_start', {
      user: req.session.user,
      exam: exam[0],
      qCount: qCount,
      assignedSet: assignedSet,
    })
  } catch (err) {
    res.status(500).send('Error: ' + err.message)
  }
})

// Helper Function: Fisher-Yates Shuffle (Place this outside your route)
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[array[i], array[j]] = [array[j], array[i]]
  }
  return array
}

// Route to show the actual questions (The Attempt Page)
app.get('/student/exam/:examId/attempt', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') {
    return res.redirect('/login')
  }

  try {
    const examId = req.params.examId
    const userId = req.session.user.user_id
    const now = new Date()

    // 1. Fetch Exam details
    const [examData] = await db.query('SELECT * FROM exams WHERE exam_id = ?', [
      examId,
    ])
    const exam = examData[0]

    // 2. TIME-BASED ACCESS CONTROL (The Gatekeeper)
    const startTime = exam.start_time ? new Date(exam.start_time) : null
    const globalEndTime = exam.end_time ? new Date(exam.end_time) : null

    // RULE A: Too Early? (Always respects the global start time)
    if (startTime && now < startTime) {
      return res.render('student_message', {
        title: 'Exam Not Started',
        message: `This assessment is scheduled to start on ${startTime.toLocaleString()}. Please return then.`,
        type: 'info',
      })
    }

    // RULE B: Too Late? (Respects the global deadline)
    if (globalEndTime && now > globalEndTime) {
      return res.render('student_message', {
        title: 'Access Closed',
        message: 'The scheduled window for this examination is now closed.',
        type: 'danger',
      })
    }

    // 3. ONE-ATTEMPT RESTRICTION
    const [existingResult] = await db.query(
      'SELECT result_id FROM results WHERE user_id = ? AND exam_id = ?',
      [userId, examId],
    )

    if (existingResult.length > 0) {
      return res.redirect('/student/history')
    }

    // 4. SET ASSIGNMENT LOGIC (A/B)
    let assignedSet = 'A'
    const [existingAssignment] = await db.query(
      'SELECT question_set FROM exam_set_assignments WHERE user_id = ? AND exam_id = ? LIMIT 1',
      [userId, examId],
    )

    if (existingAssignment.length > 0) {
      assignedSet = existingAssignment[0].question_set
    } else {
      await db.query(
        'INSERT INTO exam_set_assignments (user_id, exam_id, question_set) VALUES (?, ?, ?)',
        [userId, examId, assignedSet],
      )
    }

    // 5. PERSISTENT TIMER LOGIC
    if (!req.session.examEndTime || req.session.currentExamId !== examId) {
      const durationInMs = exam.duration_minutes * 60 * 1000
      req.session.examEndTime = Date.now() + durationInMs
      req.session.currentExamId = examId
      req.session.shuffledQuestions = null
    }

    const remainingSeconds = Math.max(
      0,
      Math.floor((req.session.examEndTime - Date.now()) / 1000),
    )

    // 6. FETCH & SHUFFLE QUESTIONS (Randomization)
    if (
      !req.session.shuffledQuestions ||
      req.session.currentExamId !== examId
    ) {
      const [questionsFromDb] = await db.query(
        'SELECT * FROM questions WHERE exam_id = ? AND question_set = ?',
        [examId, assignedSet],
      )
      req.session.shuffledQuestions = shuffleArray([...questionsFromDb])
    }

    // 7. Render
    res.render('student_exam_attempt', {
      user: req.session.user,
      exam: exam,
      questions: req.session.shuffledQuestions,
      assignedSet: assignedSet,
      remainingSeconds: remainingSeconds,
    })
  } catch (err) {
    console.error('Exam Attempt Error:', err)
    res.status(500).send('Error starting exam attempt: ' + err.message)
  }
})

app.post('/student/exam/:examId/submit', async (req, res) => {
  const examId = req.params.examId
  const studentAnswers = req.body
  const userId = req.session.user.user_id

  try {
    // 1. Identify which Set the student was assigned to
    let assignedSet = 'A'
    const [assignedRow] = await db.query(
      'SELECT question_set FROM exam_set_assignments WHERE user_id = ? AND exam_id = ? LIMIT 1',
      [userId, examId],
    )

    if (assignedRow.length > 0) {
      assignedSet = assignedRow[0].question_set
    }

    // 2. Fetch the correct answers for THAT specific set
    const [questions] = await db.query(
      'SELECT question_id, correct_answer FROM questions WHERE exam_id = ? AND question_set = ?',
      [examId, assignedSet],
    )

    const [exam] = await db.query('SELECT * FROM exams WHERE exam_id = ?', [
      examId,
    ])

    // 3. Calculate Score
    let score = 0
    const totalQuestions = questions.length

    questions.forEach((q) => {
      // Inputs are usually named like 'q123' where 123 is the ID
      const studentSelection = studentAnswers[`q${q.question_id}`]
      if (studentSelection === q.correct_answer) {
        score++
      }
    })

    const status = score >= exam[0].pass_marks ? 'PASSED' : 'FAILED'

    // 4. Save result with Question Set (Crucial for Admin Analytics)
    await db.query(
      'INSERT INTO results (user_id, exam_id, score, total_questions, status, question_set) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, examId, score, totalQuestions, status, assignedSet],
    )

    // --- 5. SESSION CLEANUP (Anti-Cheat & Resource Management) ---
    delete req.session.examEndTime // Reset the timer
    delete req.session.currentExamId // Clear the active exam ID
    delete req.session.shuffledQuestions // Clear the random order we generated
    // --------------------------------------------------------------

    // 6. Final Render
    res.render('student_result', {
      user: req.session.user,
      exam: exam[0],
      score: score,
      total: totalQuestions,
      status: status,
      assignedSet: assignedSet,
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

// --- STUDENT MANAGEMENT (New Page for Teacher) ---

// --- NOTIFICATION MANAGEMENT ---
// This route marks a notification as read and takes the admin to the student list
app.get('/admin/notifications/read/:id', async (req, res) => {
  // Security check
  if (!req.session.user || !isAdmin(req.session.user.role)) {
    return res.redirect('/login')
  }

  try {
    const noteId = req.params.id

    // 1. Mark the notification as 'read' so it disappears from the dashboard
    await db.query('UPDATE notifications SET is_read = 1 WHERE id = ?', [
      noteId,
    ])

    // 2. Redirect to the students management page to assign the roll number
    res.redirect('/admin/students')
  } catch (err) {
    console.error('Error clearing notification:', err)
    res.status(500).send('Internal Server Error')
  }
})

// 1. Show the list of students
app.get('/admin/students', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.redirect('/login')
  }
  try {
    const [courses] = await db.query(
      'SELECT * FROM courses ORDER BY course_name ASC',
    )
    const [students] = await db.query(
      "SELECT user_id, first_name, last_name, roll_no, email, class_name, year_code, is_active FROM users WHERE role = 'student' ORDER BY class_name, year_code, roll_no ASC",
    )
    res.render('admin_students', {
      user: req.session.user,
      students,
      courses,
      currentPage: 'students',
    })
  } catch (err) {
    res.status(500).send('Error loading students')
  }
})

// 2. Save the updated Student Information
app.post('/admin/students/update-roll/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin')
    return res.status(403).send('Unauthorized')

  const { course, year, roll_no } = req.body
  const studentId = req.params.id

  try {
    // Update the student's course, year, and roll number
    await db.query(
      'UPDATE users SET class_name = ?, year_code = ?, roll_no = ? WHERE user_id = ?',
      [course, year, roll_no, studentId],
    )
    res.redirect('/admin/students?success=student_updated')
  } catch (err) {
    console.error('Student Update Error:', err)
    if (err.code === 'ER_DUP_ENTRY') {
      // Duplicate roll number error
      res.redirect('/admin/students?error=already_taken')
    } else {
      // Generic error
      res.status(500).send('Error updating student information')
    }
  }
})

// Toggle Student Eligibility (Active/Inactive)
app.get('/admin/students/toggle-status/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin')
    return res.redirect('/login')
  try {
    await db.query(
      "UPDATE users SET is_active = NOT is_active WHERE user_id = ? AND role = 'student'",
      [req.params.id],
    )
    res.redirect('/admin/students?success=status_updated')
  } catch (err) {
    console.error('Toggle Error:', err)
    res.status(500).send('Error updating student status')
  }
})

ensureExamEnhancementSchema().finally(() => {
  app.listen(3000, () => {
    console.log(`🚀 Pariksha running on http://localhost:3000`)
  })
})

const express = require('express')
const session = require('express-session')
const db = require('./db')
require('dotenv').config()

const app = express()

// 1. Middleware
app.use(express.urlencoded({ extended: true }))
app.set('view engine', 'ejs')

// 2. Session Setup
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback_secret',
    resave: false,
    saveUninitialized: true,
}))

// 3. ROUTES

// Root Route
app.get('/', (req, res) => { res.redirect('/login') })

// Login Page
app.get('/login', (req, res) => { res.render('login') })

// Handle Login
app.post('/login', async (req, res) => {
    const { email, password } = req.body
    try {
        const [users] = await db.query(
            'SELECT * FROM users WHERE email = ? AND password_hash = SHA2(?, 256)',
            [email, password]
        )

        if (users.length > 0) {
            req.session.user = users[0]
            res.redirect(users[0].role === 'admin' ? '/admin/dashboard' : '/student/dashboard')
        } else {
            res.send("Invalid email or password. <a href='/login'>Try again</a>")
        }
    } catch (err) {
        res.status(500).send('Database Error: ' + err.message)
    }
})

// --- ADMIN DASHBOARD ---
app.get('/admin/dashboard', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login')

    try {
        const [[{ examCount }]] = await db.query('SELECT COUNT(*) as examCount FROM exams')
        const [[{ subjectCount }]] = await db.query('SELECT COUNT(*) as subjectCount FROM subjects')
        const [[{ studentCount }]] = await db.query("SELECT COUNT(*) as studentCount FROM users WHERE role = 'student'")
        const [recentSubjects] = await db.query('SELECT subject_name FROM subjects ORDER BY subject_id DESC LIMIT 5')

        res.render('admin_dashboard', {
            user: req.session.user,
            stats: { exams: examCount || 0, subjects: subjectCount || 0, students: studentCount || 0 },
            activities: recentSubjects,
            currentPage: 'dashboard'
        })
    } catch (err) {
        res.status(500).send('Dashboard Error')
    }
})

// --- EXAM MANAGEMENT ---
app.get('/admin/exams', async (req, res) => {
    try {
        const [subjects] = await db.query('SELECT * FROM subjects')
        const [exams] = await db.query('SELECT e.*, s.subject_name FROM exams e JOIN subjects s ON e.subject_id = s.subject_id')
        res.render('admin_exams', { user: req.session.user, subjects, exams })
    } catch (err) {
        res.status(500).send('Error loading exams')
    }
})

app.post('/admin/exams/add', async (req, res) => {
    const { subject_id, exam_name, duration_minutes, total_marks, pass_marks } = req.body
    try {
        await db.query("INSERT INTO exams (subject_id, exam_name, duration_minutes, total_marks, pass_marks, status) VALUES (?, ?, ?, ?, ?, 'draft')", 
        [subject_id, exam_name, duration_minutes, total_marks, pass_marks])
        res.redirect('/admin/exams')
    } catch (err) { res.status(500).send('Error creating exam') }
})

app.post('/admin/exams/update/:id', async (req, res) => {
    const { exam_name, duration_minutes, total_marks, pass_marks } = req.body
    try {
        await db.query('UPDATE exams SET exam_name=?, duration_minutes=?, total_marks=?, pass_marks=? WHERE exam_id=?', 
        [exam_name, duration_minutes, total_marks, pass_marks, req.params.id])
        res.redirect('/admin/exams')
    } catch (err) { res.status(500).send('Update failed') }
})

// DELETE EXAM
app.get('/admin/exams/delete/:id', async (req, res) => {
    try {
        const id = req.params.id;
        // This SQL command removes the exam from your database
        await db.query('DELETE FROM exams WHERE exam_id = ?', [id]);
        res.redirect('/admin/exams'); // Go back to the list after deleting
    } catch (err) {
        console.error(err);
        res.status(500).send('Error: Could not delete the exam. Check if questions are still attached.');
    }
});
// --- QUESTION MANAGEMENT ---
app.get('/admin/exams/:examId/questions', async (req, res) => {
    try {
        const [exam] = await db.query('SELECT * FROM exams WHERE exam_id = ?', [req.params.examId])
        const [questions] = await db.query('SELECT * FROM questions WHERE exam_id = ?', [req.params.examId])
        res.render('admin_questions', { exam: exam[0], questions })
    } catch (err) { res.status(500).send('Error loading questions') }
})

app.post('/admin/exams/:examId/questions/add', async (req, res) => {
    const { question_text, option_a, option_b, option_c, option_d, correct_answer } = req.body
    try {
        await db.query('INSERT INTO questions (exam_id, question_text, option_a, option_b, option_c, option_d, correct_answer) VALUES (?, ?, ?, ?, ?, ?, ?)', 
        [req.params.examId, question_text, option_a, option_b, option_c, option_d, correct_answer])
        res.redirect(`/admin/exams/${req.params.examId}/questions`)
    } catch (err) { res.status(500).send('Error saving question') }
})

// --- SUBJECT MANAGEMENT ---
app.get('/admin/subjects', async (req, res) => {
    try {
        const [courses] = await db.query('SELECT * FROM courses')
        const [subjects] = await db.query('SELECT s.*, c.course_name FROM subjects s JOIN courses c ON s.course_id = c.course_id')
        res.render('admin_subjects', { user: req.session.user, courses, subjects })
    } catch (err) { res.status(500).send('Error loading subjects') }
})

app.post('/admin/subjects/add', async (req, res) => {
    const { subject_name, subject_code, course_id } = req.body
    try {
        await db.query('INSERT INTO subjects (subject_name, subject_code, course_id, created_by) VALUES (?, ?, ?, ?)', 
        [subject_name, subject_code, course_id, req.session.user.user_id])
        res.redirect('/admin/subjects')
    } catch (err) { res.status(500).send('Error adding subject') }
})

// Route to handle updating a subject
app.post('/admin/subjects/update/:id', async (req, res) => {
    const { subject_name, subject_code, course_id } = req.body;
    try {
        await db.query(
            "UPDATE subjects SET subject_name=?, subject_code=?, course_id=? WHERE subject_id=?", 
            [subject_name, subject_code, course_id, req.params.id]
        );
        res.redirect('/admin/subjects');
    } catch (err) {
        res.status(500).send('Error updating subject: ' + err.message);
    }
});

app.get('/admin/subjects/delete/:id', async (req, res) => {
    try {
        await db.query("DELETE FROM subjects WHERE subject_id = ?", [req.params.id])
        res.redirect('/admin/subjects')
    } catch (err) { res.status(500).send("Subject linked to exam") }
})

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login') })

app.listen(3000, () => { console.log(`🚀 Pariksha running on http://localhost:3000`) })
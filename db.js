const mysql = require('mysql2');
require('dotenv').config();

// We create a 'pool' instead of a single connection.
// Learning: A pool allows multiple users to query the database at the same time.
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// TEST THE CONNECTION IMMEDIATELY
pool.getConnection((err, connection) => {
    if (err) {
        console.log("-----------------------------------------");
        console.log("❌ DATABASE CONNECTION ERROR:");
        console.log("Message:", err.message);
        console.log("-----------------------------------------");
    } else {
        console.log("✅ SUCCESS: Node.js is now connected to MySQL!");
        connection.release(); // Return the connection to the pool
    }
});

// We use .promise() so we can use modern 'async/await' in server.js
module.exports = pool.promise();
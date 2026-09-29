const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Database Initialization & Schema Migration
async function initDB() {
    try {
        // 1. Create base table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS patients (
                id VARCHAR(50) PRIMARY KEY,
                name TEXT NOT NULL,
                age INTEGER,
                sex VARCHAR(20),
                blood_group VARCHAR(10),
                hb NUMERIC(4,1),
                wbc INTEGER,
                glucose INTEGER,
                codis JSONB,
                flags JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // 2. Safely inject new clinical columns (Phase 1 Fix)
        await pool.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS needs_blood BOOLEAN NOT NULL DEFAULT FALSE;`);
        await pool.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS needs_organ VARCHAR(30) NOT NULL DEFAULT 'None';`);
        
        console.log("PostgreSQL database schema verified and synchronized successfully.");
    } catch (err) {
        console.error("Critical Database Initialization Error:", err);
        throw err; // Fail hard if DB is broken
    }
}

// Security Middleware
app.use(helmet());
app.use(cors({
    origin: process.env.FRONTEND_URL || '*', // Restrict this in Render later if desired
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.use(express.json({ limit: '10kb' }));

// Rate Limiter
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter);

// Authentication Middleware
const verifyPasscode = (req, res, next) => {
    const clientKey = req.headers['x-api-key'];
    if (!ADMIN_SECRET) {
        return res.status(500).json({ error: 'Server misconfiguration: Authentication key missing.' });
    }
    if (!clientKey || clientKey !== ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid security key.' });
    }
    next();
};

// Strict Validation Constants
const validSex = ['Male', 'Female', 'Other', 'Unknown'];
const validBloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const validOrgans = ['None', 'Kidney', 'Liver', 'Heart', 'Cornea'];

// Hardened Health Endpoint (Tests DB Connection)
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1'); // Actual DB ping
        res.json({ status: 'ok', database: 'connected', service: 'GenePulse API (PostgreSQL)', timestamp: new Date().toISOString() });
    } catch (err) {
        console.error('Health check failed:', err);
        res.status(503).json({ status: 'error', database: 'unavailable' });
    }
});

// GET All Patients
app.get('/api/patients', verifyPasscode, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM patients ORDER BY created_at DESC');
        const patients = result.rows.map(row => ({
            uid: row.id,
            name: row.name,
            age: String(row.age),
            sex: row.sex,
            bg: row.blood_group,
            hb: row.hb,
            wbc: row.wbc,
            glucose: row.glucose,
            needsBlood: row.needs_blood,
            needsOrgan: row.needs_organ,
            codis: row.codis,
            flags: row.flags
        }));
        res.json(patients);
    } catch (err) {
        console.error("Database Read Error:", err);
        res.status(500).json({ error: 'Internal Server Error reading records.' });
    }
});

// GET Single Patient
app.get('/api/patients/:id', verifyPasscode, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM patients WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Patient record not found.' });
        }
        const row = result.rows[0];
        res.json({
            uid: row.id,
            name: row.name,
            age: String(row.age),
            sex: row.sex,
            bg: row.blood_group,
            hb: row.hb,
            wbc: row.wbc,
            glucose: row.glucose,
            needsBlood: row.needs_blood,
            needsOrgan: row.needs_organ,
            codis: row.codis,
            flags: row.flags
        });
    } catch (err) {
        console.error("Database Lookup Error:", err);
        res.status(500).json({ error: 'Internal Server Error retrieving record.' });
    }
});

// POST New Patient (Strict Validation & Sync)
app.post('/api/patients', verifyPasscode, async (req, res) => {
    try {
        const body = req.body;
        if (!body || typeof body.name !== 'string' || body.name.trim() === '') {
            return res.status(400).json({ error: 'Validation Error: "name" is required and must be a string.' });
        }

        // Apply strict sanitization filters
        const safeSex = validSex.includes(body.sex) ? body.sex : 'Unknown';
        const safeBg = validBloodGroups.includes(body.bg) ? body.bg : 'Unknown';
        const safeOrgan = validOrgans.includes(body.needsOrgan) ? body.needsOrgan : 'None';
        const safeBloodFlag = Boolean(body.needsBlood);

        // Server-Generated ID
        const uniqueId = `GP-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
        
        const query = `
            INSERT INTO patients (id, name, age, sex, blood_group, hb, wbc, glucose, needs_blood, needs_organ, codis, flags)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `;
        const values = [
            uniqueId,
            body.name.trim(),
            Number(body.age) || 0,
            safeSex,
            safeBg,
            Number(body.hb) || 0,
            Number(body.wbc) || 0,
            Number(body.glucose) || 0,
            safeBloodFlag,
            safeOrgan,
            JSON.stringify(body.codis || null),
            JSON.stringify(body.flags || [])
        ];

        await pool.query(query, values);
        res.status(201).json({ message: 'Patient record saved securely to PostgreSQL vault!', recordId: uniqueId });
    } catch (err) {
        console.error("POST Error:", err);
        res.status(500).json({ error: 'Internal Server Error saving record.' });
    }
});

// DELETE Patient
app.delete('/api/patients/:id', verifyPasscode, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM patients WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Patient record not found.' });
        }
        res.json({ message: `Patient record ${id} deleted successfully.` });
    } catch (err) {
        console.error("Delete Error:", err);
        res.status(500).json({ error: 'Internal Server Error deleting record.' });
    }
});

// Catch-all Error Handler
app.use((err, req, res, next) => {
    console.error("Unhandled Exception:", err);
    res.status(500).json({ error: 'An unexpected server error occurred.' });
});

// Hardened Startup Sequence
async function startServer() {
    try {
        await initDB(); // Block server start until DB is ready
        app.listen(PORT, () => {
            console.log(`GenePulse secure PostgreSQL backend running on port ${PORT}`);
        });
    } catch (err) {
        console.error("Failed to start GenePulse backend:", err);
        process.exit(1);
    }
}

startServer();
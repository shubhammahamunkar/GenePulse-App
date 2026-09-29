const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
    try {
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
        console.log("PostgreSQL database table 'patients' verified/created successfully.");
    } catch (err) {
        console.error("Database initialization error:", err);
    }
}
initDB();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10kb' }));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter);

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

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'GenePulse API (PostgreSQL)', timestamp: new Date().toISOString() });
});

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
            codis: row.codis,
            flags: row.flags,
            needsBlood: row.flags ? row.flags.includes("Needs Blood") : false,
            needsOrgan: "None"
        }));
        res.json(patients);
    } catch (err) {
        console.error("Database Read Error:", err);
        res.status(500).json({ error: 'Internal Server Error reading records.' });
    }
});

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
            codis: row.codis,
            flags: row.flags
        });
    } catch (err) {
        console.error("Database Lookup Error:", err);
        res.status(500).json({ error: 'Internal Server Error retrieving record.' });
    }
});

app.post('/api/patients', verifyPasscode, async (req, res) => {
    try {
        const body = req.body;
        if (!body || typeof body.name !== 'string' || body.name.trim() === '') {
            return res.status(400).json({ error: 'Validation Error: "name" is required and must be a string.' });
        }

        const uniqueId = `GP-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
        const query = `
            INSERT INTO patients (id, name, age, sex, blood_group, hb, wbc, glucose, codis, flags)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `;
        const values = [
            uniqueId,
            body.name.trim(),
            Number(body.age) || 0,
            body.sex || 'Unknown',
            body.bg || body.bloodGroup || 'Unknown',
            Number(body.hb) || 0,
            Number(body.wbc) || 0,
            Number(body.glucose) || 0,
            JSON.stringify(body.codis || []),
            JSON.stringify(body.flags || [])
        ];

        await pool.query(query, values);
        res.status(201).json({ message: 'Patient record saved securely to PostgreSQL vault!', recordId: uniqueId });
    } catch (err) {
        console.error("POST Error:", err);
        res.status(500).json({ error: 'Internal Server Error saving record.' });
    }
});

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

app.use((err, req, res, next) => {
    console.error("Unhandled Exception:", err);
    res.status(500).json({ error: 'An unexpected server error occurred.' });
});

app.listen(PORT, () => {
    console.log(`GenePulse secure PostgreSQL backend running on port ${PORT}`);
});
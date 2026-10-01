require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

app.set('trust proxy', 1);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (err, client) => {
    console.error('Unexpected error on idle PostgreSQL client', err);
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
        // Safely upgrade existing database schema with new advanced features
        await pool.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS needs_blood BOOLEAN NOT NULL DEFAULT FALSE;`);
        await pool.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS needs_organ VARCHAR(30) NOT NULL DEFAULT 'None';`);
        await pool.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS triage_level VARCHAR(20) NOT NULL DEFAULT 'STABLE';`);
        
        console.log("PostgreSQL database schema verified and upgraded successfully.");
    } catch (err) {
        console.error("Critical Database Initialization Error:", err);
        throw err;
    }
}

app.use(helmet());
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected', service: 'GenePulse Telemetry', timestamp: new Date().toISOString() });
    } catch (err) {
        res.status(503).json({ status: 'error', database: 'unavailable' });
    }
});

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

const verifyPasscode = (req, res, next) => {
    const clientKey = req.headers['x-api-key'] || '';
    if (!ADMIN_SECRET) return res.status(500).json({ error: 'Server misconfiguration.' });
    
    const clientBuffer = Buffer.from(clientKey);
    const secretBuffer = Buffer.from(ADMIN_SECRET);
    
    if (clientBuffer.length !== secretBuffer.length || !crypto.timingSafeEqual(clientBuffer, secretBuffer)) {
        return res.status(401).json({ error: 'Unauthorized: Invalid security key.' });
    }
    next();
};

const validSex = ['Male', 'Female', 'Other', 'Unknown'];
const validBloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const validOrgans = ['None', 'Kidney', 'Liver', 'Heart', 'Cornea'];
const validTriage = ['STABLE', 'MODERATE', 'CRITICAL'];

function validatePatientRecord(body) {
    if (!body || typeof body.name !== 'string' || body.name.trim() === '') return null;
    const parsedAge = parseInt(body.age, 10);
    if (isNaN(parsedAge) || parsedAge < 0 || parsedAge > 120) return null;
    const parsedHb = parseFloat(body.hb);
    if (isNaN(parsedHb) || parsedHb < 0 || parsedHb > 30) return null;
    const parsedWbc = parseInt(body.wbc, 10);
    if (isNaN(parsedWbc) || parsedWbc < 0 || parsedWbc > 100000) return null;
    const parsedGlucose = parseInt(body.glucose, 10);
    if (isNaN(parsedGlucose) || parsedGlucose < 0 || parsedGlucose > 1000) return null;

    let safeCodis = null;
    if (body.codis) {
        if (!Array.isArray(body.codis) || body.codis.length !== 13 || !body.codis.every(n => Number.isFinite(n))) return null;
        safeCodis = body.codis;
    }

    let safeFlags = [];
    if (body.flags !== undefined) {
        if (!Array.isArray(body.flags)) return null;
        safeFlags = body.flags.filter(f => typeof f === 'string').slice(0, 10);
    }

    const uniqueId = (body.uid && typeof body.uid === 'string' && body.uid.startsWith('GP-')) 
        ? body.uid 
        : `GP-${new Date().getFullYear()}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;

    return {
        uniqueId, 
        name: body.name.trim(), 
        parsedAge, 
        safeSex: validSex.includes(body.sex) ? body.sex : 'Unknown', 
        safeBg: validBloodGroups.includes(body.bg) ? body.bg : 'Unknown', 
        parsedHb, 
        parsedWbc, 
        parsedGlucose, 
        safeBloodFlag: body.needsBlood === true, 
        safeOrgan: validOrgans.includes(body.needsOrgan) ? body.needsOrgan : 'None', 
        safeTriage: validTriage.includes(body.triage) ? body.triage : 'STABLE',
        safeCodis, 
        safeFlags
    };
}

app.get('/api/patients', verifyPasscode, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM patients ORDER BY created_at DESC');
        const patients = result.rows.map(row => ({
            uid: row.id, name: row.name, age: String(row.age), sex: row.sex, bg: row.blood_group,
            hb: row.hb, wbc: row.wbc, glucose: row.glucose, needsBlood: row.needs_blood,
            needsOrgan: row.needs_organ, triage: row.triage_level, codis: row.codis, flags: row.flags
        }));
        res.json(patients);
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error reading records.' });
    }
});

app.post('/api/patients', verifyPasscode, async (req, res) => {
    try {
        const validData = validatePatientRecord(req.body);
        if (!validData) return res.status(400).json({ error: 'Validation Error.' });
        
        await pool.query(`
            INSERT INTO patients (id, name, age, sex, blood_group, hb, wbc, glucose, needs_blood, needs_organ, triage_level, codis, flags)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `, [
            validData.uniqueId, validData.name, validData.parsedAge, validData.safeSex, validData.safeBg, 
            validData.parsedHb, validData.parsedWbc, validData.parsedGlucose, validData.safeBloodFlag, 
            validData.safeOrgan, validData.safeTriage, JSON.stringify(validData.safeCodis), JSON.stringify(validData.safeFlags)
        ]);
        res.status(201).json({ message: 'Saved successfully.', recordId: validData.uniqueId });
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error saving record.' });
    }
});

app.post('/api/patients/bulk', verifyPasscode, async (req, res) => {
    const patients = req.body;
    if (!Array.isArray(patients)) return res.status(400).json({ error: 'Expected JSON array.' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        let count = 0, skipped = 0, invalid = 0;
        for (const p of patients) {
            const validData = validatePatientRecord(p);
            if (!validData) { invalid++; continue; }
            const result = await client.query(`
                INSERT INTO patients (id, name, age, sex, blood_group, hb, wbc, glucose, needs_blood, needs_organ, triage_level, codis, flags)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (id) DO NOTHING
            `, [
                validData.uniqueId, validData.name, validData.parsedAge, validData.safeSex, validData.safeBg, 
                validData.parsedHb, validData.parsedWbc, validData.parsedGlucose, validData.safeBloodFlag, 
                validData.safeOrgan, validData.safeTriage, JSON.stringify(validData.safeCodis), JSON.stringify(validData.safeFlags)
            ]);
            if (result.rowCount === 1) count++; else skipped++;
        }
        await client.query('COMMIT');
        res.status(201).json({ message: 'Bulk import complete.', inserted: count, skipped, invalid });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(500).json({ error: 'Server Error during bulk import.' });
    } finally {
        if (client) client.release();
    }
});

app.delete('/api/patients/:id', verifyPasscode, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM patients WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
        res.json({ message: `Deleted ${id}` });
    } catch (err) {
        res.status(500).json({ error: 'Server Error deleting record.' });
    }
});

async function startServer() {
    try {
        await initDB(); 
        app.listen(PORT, () => console.log(`GenePulse Advanced Backend running on port ${PORT}`));
    } catch (err) {
        process.exit(1);
    }
}

startServer();
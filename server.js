const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const filePath = './patients.json';

// --- THE BOUNCER (Security Middleware) ---
const ADMIN_SECRET = "genepulse_secure_2026";

function verifyPasscode(req, res, next) {
    const clientKey = req.headers['x-api-key'];
    if (clientKey === ADMIN_SECRET) {
        next();
    } else {
        res.status(401).json({ success: false, message: "Access Denied: Invalid or missing security key." });
    }
}

// Middleware
app.use(cors());
app.use(express.json());

// Database Helper Functions
function getPatients() {
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, 'utf8');
    return data ? JSON.parse(data) : [];
}

function savePatient(newPatient) {
    const patients = getPatients();
    patients.push(newPatient);
    fs.writeFileSync(filePath, JSON.stringify(patients, null, 2));
}

// 1. Protected API Route to RECEIVE a patient securely
app.post('/api/patients', verifyPasscode, (req, res) => {
    const patientData = req.body;
    savePatient(patientData);
    console.log("Server successfully saved (Secure):", patientData.name);
    res.json({ success: true, message: "Saved securely to folder vault!" });
});

// 2. API Route to SEND all saved patients back to your frontend
app.get('/api/patients', (req, res) => {
    const patients = getPatients();
    res.json(patients);
});

// Start the server
app.listen(PORT, () => {
    console.log(`GenePulse Server running live on port ${PORT}`);
});
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const academicsRoutes = require('./routes/academics');
const libraryRoutes = require('./routes/library');
const groupsRoutes = require('./routes/groups');
const assessmentsRoutes = require('./routes/assessments');
const adminRoutes = require('./routes/admin');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api', academicsRoutes);
app.use('/api', libraryRoutes);
app.use('/api', groupsRoutes);
app.use('/api', assessmentsRoutes);
app.use('/api/admin', adminRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => console.log(`VarsityPass API listening on port ${PORT}`));

require('./seed')().catch((e) => console.error('Seed check failed:', e.message));

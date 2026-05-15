require('dotenv').config();

const express = require('express');
const cors = require('cors');

const connectDB = require('./db/connect');

const {
    initializeDynamicPool
} = require('./serviceFiles/squadService');

const app = express();

/**
 * Middleware
 */
app.use(cors({
    origin: process.env.CLIENT_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true
}));

app.use(express.json({
    limit: '50mb'
}));

app.use(express.urlencoded({
    limit: '50mb',
    extended: true
}));

/**
 * Health Check
 */
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'GrainTrust Backend'
    });
});

/**
 * Initialize App
 */
connectDB().then(async () => {

    try {

        /**
         * Initialize Squad Dynamic VA Pool
         * Runs once on startup
         */
        await initializeDynamicPool(10);

    } catch (error) {

        console.error(
            '❌ Pool Initialization Failed:',
            error?.response?.data || error.message
        );
    }

    /**
     * Routes
     */
    const squadRoutes =
        require('./controllers/squadController');

    app.use('/api/squad', squadRoutes);

    /**
     * Start Server
     */
    const PORT = process.env.PORT || 3000;

    app.listen(PORT, () => {

        console.log(
            `🚀 Server running on http://localhost:${PORT}`
        );

        console.log(
            `🌐 Configure Squad webhook to your ngrok URL`
        );
    });

}).catch((error) => {

    console.error(
        '❌ MongoDB Connection Failed:',
        error.message
    );
});
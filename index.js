require('dotenv').config();

const express = require('express');

const connectDB = require('./db/connect');

const {
    initializeDynamicPool
} = require('./serviceFiles/squadService');

const app = express();

app.use(express.json());

connectDB().then(async () => {

    /**
     * Initialize Squad Dynamic VA Pool
     * Runs once on startup
     */
    await initializeDynamicPool(10);

    const squadRoutes =
        require('./controllers/squadController');

    app.use('/api/squad', squadRoutes);

    const PORT = process.env.PORT || 3000;

    app.listen(PORT, () => {

        console.log(
            `🚀 Server running on http://localhost:${PORT}`
        );

        console.log(
            `🌐 Configure Squad webhook to your ngrok URL`
        );
    });
});
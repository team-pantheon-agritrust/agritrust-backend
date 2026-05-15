require('dotenv').config();
const express = require('express');
const connectDB = require('./db/connect');

const app = express();
app.use(express.json());

// Connect to MongoDB before starting the server
connectDB().then(() => {
    const squadRoutes = require('./controllers/squadController');
    app.use('/api/squad', squadRoutes);

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
        console.log(`Squad should be pointing to your Ngrok URL!`);
    });
});


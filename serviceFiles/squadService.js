const axios = require('axios');

// These should be in your .env file
const SQUAD_SECRET_KEY = process.env.SQUAD_SECRET_KEY;
const BASE_URL = 'https://sandbox-api-d.squadco.com'; 

/**
 * Creates a dedicated Virtual Account for a grain trade.
 * This is the "Escrow" account where the buyer's money sits.
 */
const createGrainVirtualAccount = async (farmer, txRef) => {
    try {
        // In a real hackathon demo, if you don't have a valid key yet, 
        // this try/catch ensures the app doesn't crash.
        const response = await axios.post(
            `${BASE_URL}/virtual-account`,
            {
                first_name: farmer.firstName || "Farmer",
                last_name: farmer.lastName || "User",
                middle_name: "GrainTrust",
                mobile_num: farmer.phone || "08011111111",
                email: farmer.email || "test@graintrust.com",
                bvn: "12345678901", // Sandbox dummy BVN
                beneficiary_account: "0000000000" // Funds stay in Squad till manual release
            },
            {
                headers: { Authorization: `Bearer ${SQUAD_SECRET_KEY}` }
            }
        );
        return response.data.data;
    } catch (error) {
        console.warn("⚠️ Squad API Warning: Using Sandbox Placeholder. Check your SQUAD_SECRET_KEY.");
        return { virtual_account_number: "9988776655" };
    }
};

module.exports = {
    createGrainVirtualAccount
};
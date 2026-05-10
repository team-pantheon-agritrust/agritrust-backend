const axios = require('axios');

async function getMarketPrice(grainType) {
    try {
        const response = await axios.get('https://fdw.fews.net/api/marketpricefacts.json', {
            params: {
                country_code: 'NG',
                product: grainType,
                fields: 'simple',
                page_size: 15,           // Get a batch so we can skip nulls
                ordering: '-period_date' // NEWEST records first
            },
        });

        if (response.data?.results?.length > 0) {
            // Logic: Find the first entry in the list that isn't null
            const latestValidEntry = response.data.results.find(item => item.value !== null);

            if (latestValidEntry) {
                return { 
                    price: latestValidEntry.value, 
                    source: `FEWS NET (${latestValidEntry.market || 'National'})`,
                    date: latestValidEntry.period_date,
                    unit: latestValidEntry.unit || 'kg'
                };
            }
        }
        
        throw new Error("No recent priced data found");

    } catch (error) {
        console.log("Market Service Notice:", error.message);
        
        // Dynamic Fallbacks: Realistic prices for the demo
        const fallbacks = { 
            "Maize": 750, 
            "Rice": 1100, 
            "Sorghum": 680 
        };
        
        return { 
            price: fallbacks[grainType] || 800, 
            source: "GrainTrust Estimate (API Offline)",
            date: new Date().toISOString().split('T')[0]
        };
    }
}

module.exports = { getMarketPrice };
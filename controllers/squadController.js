const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const squadService  = require('../serviceFiles/squadService');
const marketService = require('../serviceFiles/marketService');
const { Transaction, Scan } = require('../db/models');
const axios   = require('axios');

const ML_API = process.env.ML_API_URL || 'http://localhost:5000';

// ─── 1. INITIATE SALE (Challenge 2 Start) ───────────────────────────────────
router.post('/initiate-sale', async (req, res) => {
    const { farmer, grainType, quantity, scanId } = req.body;
    const qty = parseFloat(quantity) || 1;

    try {
        // A. Get real-time unit price
        const marketPriceData = await marketService.getMarketPrice(grainType);
        const unitPrice = parseFloat(marketPriceData.price);
        const totalPrice = unitPrice * qty;

        // B. Generate unique reference
        const txRef = `GT_${Date.now()}`;

        // C. Create Squad virtual account (Escrow)
        const squadAccount = await squadService.createGrainVirtualAccount(farmer, txRef);
        const virtualAcc = squadAccount?.virtual_account_number || "9988776655";

        // D. 🛡️ Save as PENDING in MongoDB
        const newTransaction = await Transaction.create({
            txRef: txRef,
            scanId: scanId || null, 
            farmer: farmer,
            grainType: grainType,
            quantity: qty,
            unitPrice: unitPrice,
            totalAmount: totalPrice,
            virtualAccount: virtualAcc,
            status: 'PENDING'
        });

        res.json({
            status: "success",
            transactionId: newTransaction._id,
            transactionRef: txRef,
            calculations: {
                grain: grainType,
                quantity: `${qty} kg`,
                unitPrice: `₦${unitPrice.toLocaleString()}`,
                totalAmountToPay: `₦${totalPrice.toLocaleString()}`
            },
            paymentDetails: {
                bank: "GTBank (Squad)",
                accountNumber: virtualAcc,
                instructions: `Transfer exactly ₦${totalPrice.toLocaleString()} to secure this trade.`
            }
        });

    } catch (error) {
        console.error("Sale Initiation Error:", error);
        res.status(500).json({ status: "error", message: "Database or Service error" });
    }
});

// ─── 2. SQUAD WEBHOOK (The "Tight" Logic for Payments) ──────────────────────
router.post('/webhook', async (req, res) => {
    // 1. Verify the request actually came from Squad
    const squadSignature = req.headers['x-squad-encrypted-body'];
    if (squadSignature) {
        const expectedHash = crypto
            .createHmac('sha512', process.env.SQUAD_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (expectedHash !== squadSignature) {
            console.warn("⚠️ SECURITY: Webhook signature mismatch. Rejecting.");
            return res.status(401).json({ message: "Invalid signature" });
        }
    }

    console.log("📡 Incoming Webhook from Squad...");
    const { event, data } = req.body;

    // We only care about successful charges
    if (event === 'charge.success') {
        const txRef = data.transaction_ref;
        const amountReceived = data.amount / 100; // Convert Kobo to Naira

        try {
            // 2. Fetch the transaction from your DB
            const transaction = await Transaction.findOne({ txRef });

            if (!transaction) {
                console.error(`❌ ERROR: Transaction ${txRef} not found in database.`);
                return res.status(404).json({ message: "Transaction not found" });
            }

            // 3. Prevent Duplicate Processing (Idempotency)
            if (transaction.status !== 'PENDING') {
                console.log(`ℹ️ INFO: Transaction ${txRef} is already ${transaction.status}. Skipping.`);
                return res.status(200).json({ message: "Already processed" });
            }

            // 4. AMOUNT VALIDATION (The Security Layer)
            // Use a small margin (0.01) to account for floating-point math
            const expectedAmount = transaction.totalAmount;
            const isAmountCorrect = Math.abs(amountReceived - expectedAmount) < 0.01;

            if (!isAmountCorrect) {
                console.warn(`⚠️ FRAUD ALERT: Expected ₦${expectedAmount}, but received ₦${amountReceived}`);
                
                // Update to DISPUTED so the farmer doesn't ship the goods
                transaction.status = 'DISPUTED';
                transaction.deliveryMatchOk = false; // Mark as financial mismatch
                await transaction.save();

                return res.status(200).json({ 
                    message: "Amount mismatch detected. Transaction moved to Dispute." 
                });
            }

            // 5. SUCCESS PATH: Update status to PAID
            console.log(`✅ VALIDATED: Received ₦${amountReceived} for Trade ${txRef}`);
            
            transaction.status = 'PAID';
            transaction.paidAt = new Date();
            await transaction.save();

            // At this point, the Frontend would show "Payment Confirmed! Farmer is shipping..."
            return res.status(200).json({ message: "Payment verified and updated to PAID" });

        } catch (err) {
            console.error('❌ Webhook Processing Error:', err.message);
            // Return 500 so Squad knows to retry the webhook later
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }

    // Default response for other events
    res.status(200).send("Event acknowledged");
});

// ─── 3. VERIFY DELIVERY (Challenge 1 & 2 Merge) ─────────────────────────────
// The buyer scans the grain on arrival. We compare it to the initial AI scan.
router.post('/verify-delivery', async (req, res) => {
    const { txRef, deliveryGrade } = req.body;

    try {
        const transaction = await Transaction.findOne({ txRef }).populate('scanId');

        if (!transaction) {
            return res.status(404).json({ status: "error", message: "Trade not found" });
        }

        // Compare arrival grade to the AI grade from the original scan
        const originalGrade = transaction.scanId?.aiGrade || 'B'; 
        const isMatch = originalGrade === deliveryGrade;

        transaction.deliveryGrade = deliveryGrade;
        transaction.deliveryMatchOk = isMatch;
        transaction.status = isMatch ? 'RELEASED' : 'DISPUTED';
        
        if (isMatch) transaction.releasedAt = new Date();
        await transaction.save();

        res.json({
            status: "success",
            outcome: transaction.status,
            message: isMatch 
                ? `Quality Verified (${deliveryGrade}). Funds released to farmer.` 
                : `Quality Mismatch! Scanned: ${originalGrade}, Delivered: ${deliveryGrade}. Funds held in dispute.`
        });

    } catch (error) {
        res.status(500).json({ status: "error", message: "Verification failed" });
    }
});

// ADMIN ONLY: Resolve a disputed transaction manually
router.post('/resolve-dispute', async (req, res) => {
    const { txRef, resolution, adminSecret } = req.body;

    if (adminSecret !== process.env.ADMIN_SECRET || !adminSecret) {
        return res.status(403).json({ message: "Unauthorized" });
    }

    try {
        const transaction = await Transaction.findOne({ txRef });

        if (!transaction) {
            return res.status(404).json({ status: "error", message: "Transaction not found" });
        }

        if (transaction.status !== 'DISPUTED') {
            return res.status(400).json({ 
                status: "error", 
                message: `Cannot resolve — transaction is currently ${transaction.status}` 
            });
        }

        if (resolution === "ACCEPT_PAYMENT") {
            transaction.status = 'RELEASED';
            transaction.resolutionNote = "Dispute resolved by Admin: Payment accepted, funds released to farmer.";
            transaction.releasedAt = new Date();
        } else if (resolution === "REFUND") {
            transaction.status = 'REFUNDED';
            transaction.resolutionNote = "Dispute resolved by Admin: Funds returned to buyer.";
        } else {
            return res.status(400).json({ status: "error", message: "Invalid resolution type. Use ACCEPT_PAYMENT or REFUND." });
        }

        transaction.resolvedAt = new Date();
        await transaction.save();

        res.json({ status: "success", message: `Trade ${txRef} is now ${transaction.status}` });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ─── 5. CREATE SCAN RECORD (AI/ML → Backend handoff) ────────────────────────
// Called by the AI service after it grades a grain image.
// Returns the scanId the frontend will pass into /initiate-sale.
router.post('/scan', async (req, res) => {
    const { farmer, grainType, aiGrade, aiScore, defects, gps } = req.body;

    if (!grainType || !aiGrade) {
        return res.status(400).json({ 
            status: "error", 
            message: "grainType and aiGrade are required" 
        });
    }

    if (!['A', 'B', 'C'].includes(aiGrade)) {
        return res.status(400).json({ 
            status: "error", 
            message: "aiGrade must be A, B, or C" 
        });
    }

    try {
        // Fetch live price so it's locked at scan time — not later when /initiate-sale is called
        const marketPriceData = await marketService.getMarketPrice(grainType);

        const scan = await Scan.create({
            farmer:    farmer   || {},
            grainType,
            aiGrade,
            aiScore:   aiScore  || null,
            defects:   defects  || [],
            unitPrice: marketPriceData.price,
            gps:       gps      || {},
        });

        res.status(201).json({
            status:      "success",
            scanId:      scan._id,
            grade:       aiGrade,
            defects:     scan.defects,
            unitPrice:   `₦${marketPriceData.price.toLocaleString()}`,
            priceSource: marketPriceData.source,
            message:     `Grain graded ${aiGrade}. Pass scanId to /initiate-sale to start the trade.`
        });

    } catch (error) {
        console.error("Scan Creation Error:", error);
        res.status(500).json({ status: "error", message: "Failed to save scan record" });
    }
});

// ─── 6. FARMER TRUST SCORE ───────────────────────────────────────────────────
// Calculates score from delivery history: how often does delivered grade match scanned grade?
// High score → lower platform fee (surfaced to Squad split-payment logic).
router.get('/farmer/:phone/trust-score', async (req, res) => {
    const { phone } = req.params;

    try {
        const completedTrades = await Transaction.find({
            'farmer.phone': phone,
            status: { $in: ['RELEASED', 'DISPUTED', 'REFUNDED'] }
        });

        const totalTrades = completedTrades.length;

        if (totalTrades === 0) {
            return res.json({
                status:      "success",
                phone,
                trustScore:  null,
                grade:       "UNRATED",
                totalTrades: 0,
                message:     "No completed trades yet. Score will appear after first delivery."
            });
        }

        const honestTrades = completedTrades.filter(t => t.deliveryMatchOk === true).length;
        const trustScore   = Math.round((honestTrades / totalTrades) * 100);

        // Tier mapping for the dashboard
        let trustGrade;
        if      (trustScore >= 90) trustGrade = 'PLATINUM';
        else if (trustScore >= 75) trustGrade = 'GOLD';
        else if (trustScore >= 50) trustGrade = 'SILVER';
        else                       trustGrade = 'BRONZE';

        // Incentive structure: higher trust = lower platform fee
        let platformFeePercent;
        if      (trustScore >= 90) platformFeePercent = 2;
        else if (trustScore >= 75) platformFeePercent = 3.5;
        else                       platformFeePercent = 5;

        res.json({
            status:             "success",
            phone,
            trustScore,          // 0–100
            grade:              trustGrade,
            totalTrades,
            honestTrades,
            platformFeePercent,  // used by Squad split-payment logic
            message: `${trustGrade} farmer — ${trustScore}% delivery accuracy over ${totalTrades} trades.`
        });

    } catch (error) {
        console.error("Trust Score Error:", error);
        res.status(500).json({ status: "error", message: "Could not compute trust score" });
    }
});

// ─── 7. OFFLINE SYNC ─────────────────────────────────────────────────────────
// Called by the mobile app when connectivity is restored.
// Accepts a batch of scans captured offline (TF Lite) and persists them to MongoDB.
// Returns scanIds so the app can immediately trigger sales for each.
router.post('/sync-offline-scans', async (req, res) => {
    const { scans } = req.body;

    if (!Array.isArray(scans) || scans.length === 0) {
        return res.status(400).json({ 
            status:  "error", 
            message: "Provide a non-empty 'scans' array" 
        });
    }

    const results  = [];
    const failures = [];

    for (const raw of scans) {
        if (!raw.grainType || !raw.aiGrade || !['A', 'B', 'C'].includes(raw.aiGrade)) {
            failures.push({ raw, reason: "Missing or invalid grainType / aiGrade" });
            continue;
        }

        try {
            const marketPriceData = await marketService.getMarketPrice(raw.grainType);

            const createPayload = {
                farmer:    raw.farmer    || {},
                grainType: raw.grainType,
                aiGrade:   raw.aiGrade,
                aiScore:   raw.aiScore   || null,
                defects:   raw.defects   || [],
                unitPrice: marketPriceData.price,
                gps:       raw.gps       || {},
            };

            // Preserve the original offline timestamp if the app sent one
            if (raw.scannedAt) {
                createPayload.createdAt = new Date(raw.scannedAt);
            }

            const scan = await Scan.create(createPayload);

            results.push({ 
                scanId:      scan._id, 
                grainType:   raw.grainType,
                aiGrade:     raw.aiGrade,
                unitPrice:   marketPriceData.price,
                priceSource: marketPriceData.source,
            });
        } catch (err) {
            failures.push({ raw, reason: err.message });
        }
    }

    // 207 Multi-Status: correct when some items in a batch may have failed
    res.status(207).json({
        status:   failures.length === 0 ? "success" : "partial",
        synced:   results.length,
        failed:   failures.length,
        results,
        failures,
        message:  `${results.length}/${scans.length} scans synced successfully.`
    });
});

// ─── 8. GRADE AND SCAN (Unified AI → Payment pipeline) ──────────────────────
// Single endpoint for the mobile app. Sends image here, gets back grade + payment details.
// Node proxies to the Python ML service internally — app makes ONE call.
router.post('/grade-and-scan', async (req, res) => {
    const { farmer, grainType, quantity, imageBase64, gps, weatherData } = req.body;

    // Validate required fields before touching any service
    if (!imageBase64)  return res.status(400).json({ status: "error", message: "imageBase64 is required" });
    if (!grainType)    return res.status(400).json({ status: "error", message: "grainType is required" });
    if (!farmer?.phone) return res.status(400).json({ status: "error", message: "farmer.phone is required" });

    try {
        // ── Step 1: Call the Python ML service ──────────────────────────────
        let mlData;
        try {
            const mlResponse = await axios.post(`${ML_API}/api/grade-grain`, {
                image_base64: imageBase64,
                farmer_id:    farmer.phone,   // agreed identifier across both services
                latitude:     gps?.lat  || null,
                longitude:    gps?.lng  || null,
                weather_data: weatherData || {}
            });
            mlData = mlResponse.data;
        } catch (mlErr) {
            console.error("❌ ML Service unreachable:", mlErr.message);
            return res.status(502).json({
                status:  "error",
                message: "AI grading service is unavailable. Please try again.",
            });
        }

        const { grade, quality_score, confidence, breakdown, reasoning } = mlResponse.data;

        const defects = [];
        if (breakdown.defect_assessment === 'Medium') defects.push('moderate_defects');
        if (breakdown.defect_assessment === 'High') defects.push('significant_defects');
        if (breakdown.dark_blobs_detected > 0) defects.push(`blobs_detected:${breakdown.dark_blobs_detected}`);

        if (!['A', 'B', 'C'].includes(grade)) {
            return res.status(502).json({ 
                status:  "error", 
                message: `ML service returned unexpected grade: ${grade}` 
            });
        }

        // ── Step 2: Lock in market price + persist scan record ───────────────
        const marketPriceData = await marketService.getMarketPrice(grainType);
        const unitPrice = marketPriceData.price;

        const scan = await Scan.create({
            farmer,
            grainType,
            aiGrade:   grade,
            aiScore:   quality_score || null,
            defects:   Array.isArray(defects) ? defects : [],
            unitPrice,
            gps: gps || {},
        });

        // ── Step 3: If quantity provided, auto-initiate the escrow trade ─────
        if (quantity) {
            const qty        = parseFloat(quantity);
            const totalAmount = unitPrice * qty;
            const txRef      = `GT_${Date.now()}`;

            const squadAcc   = await squadService.createGrainVirtualAccount(farmer, txRef);
            const virtualAcc = squadAcc?.virtual_account_number || "9988776655";

            const transaction = await Transaction.create({
                txRef,
                scanId:       scan._id,
                farmer,
                grainType,
                quantity:     qty,
                unitPrice,
                totalAmount,
                virtualAccount: virtualAcc,
                status:       'PENDING',
            });

            return res.status(201).json({
                status: "success",
                ai: {
                    grade,
                    confidence,
                    defects,
                    aiScore:  quality_score,
                    reasoning, 
                    breakdown,
                },
                scanId:          scan._id,
                transactionRef:  txRef,
                transactionId:   transaction._id,
                priceInfo: {
                    unitPrice:   `₦${unitPrice.toLocaleString()}`,
                    quantity:    `${qty} kg`,
                    totalAmount: `₦${totalAmount.toLocaleString()}`,
                    source:      marketPriceData.source,
                },
                paymentDetails: {
                    bank:           "GTBank (Squad)",
                    accountNumber:  virtualAcc,
                    instructions:   `Transfer exactly ₦${totalAmount.toLocaleString()} to secure this trade.`,
                },
            });
        }

        // ── Grade-only response (no quantity provided) ───────────────────────
        res.status(201).json({
            status: "success",
            ai: {
                grade,
                confidence,
                defects:  scan.defects,
                aiScore:  quality_score,
            },
            scanId:    scan._id,
            unitPrice: `₦${unitPrice.toLocaleString()}`,
            source:    marketPriceData.source,
            message:   `Grain graded ${grade}. Send quantity to initiate trade.`,
        });

    } catch (error) {
        console.error("Grade-and-scan error:", error.message);
        res.status(500).json({ status: "error", message: "Grading or scan pipeline failed" });
    }
});

module.exports = router;
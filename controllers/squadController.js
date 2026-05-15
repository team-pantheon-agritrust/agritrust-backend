const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const squadService  = require('../serviceFiles/squadService');
const marketService = require('../serviceFiles/marketService');
const { Transaction, Scan } = require('../db/models');
const axios   = require('axios');

const ML_API = process.env.ML_API_URL || 'http://localhost:5000';

// Valid grain types — whitelist prevents arbitrary strings hitting FEWS NET
const VALID_GRAINS = ['Maize', 'Rice', 'Sorghum'];

// ─── 1. INITIATE SALE ────────────────────────────────────────────────────────
router.post('/initiate-sale', async (req, res) => {
    const { farmer, grainType, quantity, scanId } = req.body;

    if (!quantity || parseFloat(quantity) <= 0) {
        return res.status(400).json({ status: "error", message: "quantity must be a positive number" });
    }

    if (!VALID_GRAINS.includes(grainType)) {
        return res.status(400).json({ status: "error", message: `grainType must be one of: ${VALID_GRAINS.join(', ')}` });
    }

    const qty = parseFloat(quantity);

    try {
        const marketPriceData = await marketService.getMarketPrice(grainType);
        const unitPrice  = parseFloat(marketPriceData.price);
        const totalPrice = unitPrice * qty;
        const txRef      = `GT_${Date.now()}`;

        const squadAccount = await squadService.createGrainVirtualAccount(farmer, txRef);
        const virtualAcc   = squadAccount?.virtual_account_number || "9988776655";

        const newTransaction = await Transaction.create({
            txRef,
            scanId:         scanId || null,
            farmer,
            grainType,
            quantity:       qty,
            unitPrice,
            totalAmount:    totalPrice,
            virtualAccount: virtualAcc,
            status:         'PENDING'
        });

        res.json({
            status:         "success",
            transactionId:  newTransaction._id,
            transactionRef: txRef,
            calculations: {
                grain:            grainType,
                quantity:         `${qty} kg`,
                unitPrice:        `₦${unitPrice.toLocaleString()}`,
                totalAmountToPay: `₦${totalPrice.toLocaleString()}`
            },
            paymentDetails: {
                bank:          "GTBank (Squad)",
                accountNumber: virtualAcc,
                instructions:  `Transfer exactly ₦${totalPrice.toLocaleString()} to secure this trade.`
            }
        });

    } catch (error) {
        console.error("Sale Initiation Error:", error);
        res.status(500).json({ status: "error", message: "Database or Service error" });
    }
});

// ─── 2. SQUAD WEBHOOK ────────────────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
    const squadSignature = req.headers['x-squad-encrypted-body'];
    if (squadSignature) {
        const expectedHash = crypto
            .createHmac('sha512', process.env.SQUAD_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (expectedHash !== squadSignature) {
            console.warn("SECURITY: Webhook signature mismatch. Rejecting.");
            return res.status(401).json({ message: "Invalid signature" });
        }
    }

    console.log("Incoming Webhook from Squad...");
    const { event, data } = req.body;

    if (event === 'charge.success') {
        const txRef          = data.transaction_ref;
        const amountReceived = data.amount / 100;

        try {
            const transaction = await Transaction.findOne({ txRef });

            if (!transaction) {
                console.error(`ERROR: Transaction ${txRef} not found.`);
                return res.status(404).json({ message: "Transaction not found" });
            }

            if (transaction.status !== 'PENDING') {
                console.log(`INFO: Transaction ${txRef} already ${transaction.status}. Skipping.`);
                return res.status(200).json({ message: "Already processed" });
            }

            const expectedAmount  = transaction.totalAmount;
            const isAmountCorrect = Math.abs(amountReceived - expectedAmount) < 0.01;

            if (!isAmountCorrect) {
                console.warn(`FRAUD ALERT: Expected ₦${expectedAmount}, received ₦${amountReceived}`);
                transaction.status          = 'DISPUTED';
                transaction.deliveryMatchOk = false;
                await transaction.save();
                return res.status(200).json({ message: "Amount mismatch detected. Transaction moved to Dispute." });
            }

            transaction.status = 'PAID';
            transaction.paidAt = new Date();
            await transaction.save();

            return res.status(200).json({ message: "Payment verified and updated to PAID" });

        } catch (err) {
            console.error('Webhook Processing Error:', err.message);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }

    res.status(200).send("Event acknowledged");
});

// ─── 3. VERIFY DELIVERY ──────────────────────────────────────────────────────
router.post('/verify-delivery', async (req, res) => {
    const { txRef, deliveryGrade } = req.body;

    if (!txRef || !deliveryGrade) {
        return res.status(400).json({ status: "error", message: "txRef and deliveryGrade are required" });
    }

    if (!['A', 'B', 'C'].includes(deliveryGrade)) {
        return res.status(400).json({ status: "error", message: "deliveryGrade must be A, B, or C" });
    }

    try {
        const transaction = await Transaction.findOne({ txRef }).populate('scanId');

        if (!transaction) {
            return res.status(404).json({ status: "error", message: "Trade not found" });
        }

        if (transaction.status !== 'PAID') {
            return res.status(400).json({
                status:  "error",
                message: `Cannot verify delivery — transaction is ${transaction.status}, not PAID`
            });
        }

        const originalGrade = transaction.scanId?.aiGrade || 'B';
        const isMatch       = originalGrade === deliveryGrade;

        transaction.deliveryGrade   = deliveryGrade;
        transaction.deliveryMatchOk = isMatch;

        if (isMatch) {
            // 1. Calculate Payout (Kobo)
            // Note: Squad API works in Kobo. ₦100 = 10000 Kobo.
            const totalKobo = transaction.totalAmount * 100;
            
            // Apply a dynamic platform fee based on the hackathon logic (e.g., 3%)
            const platformFee = 0.03; 
            const payoutAmount = Math.floor(totalKobo * (1 - platformFee));

            // 2. Trigger Squad Disbursement
            // This moves money from your Squad Escrow to the Farmer's actual bank
            const disbursement = await squadService.disburseToFarmer({
                amount: payoutAmount,
                bankCode: "000058", // This should ideally come from a Farmer Profile model
                accountNumber: "0123456789", 
                accountName: `${transaction.farmer.firstName} ${transaction.farmer.lastName}`,
                txRef: transaction.txRef
            });

            // 3. Notify ML Service to update Trust Score
            // This aligns with the ML Engineer's README: POST /api/record-delivery
            try {
                await axios.post(`${ML_API}/api/record-delivery`, {
                    farmer_id: transaction.farmer.phone, // using phone as ID
                    actual_grade: deliveryGrade,
                    predicted_grade: originalGrade,
                    tx_ref: txRef
                });
            } catch (mlErr) {
                console.log("Trust Update Note: ML Service unreachable, but payment processed.");
            }

            transaction.status = 'RELEASED';
            transaction.releasedAt = new Date();
            
            await transaction.save();

            res.json({
                status: "success",
                outcome: "RELEASED",
                disbursementId: disbursement?.data?.transaction_reference,
                message: `Quality Verified. ₦${(payoutAmount/100).toLocaleString()} disbursed to farmer (3% fee applied).`
            });

        } else {
            // Quality Mismatch logic
            transaction.status = 'DISPUTED';
            await transaction.save();

            res.json({
                status: "warning",
                outcome: "DISPUTED",
                message: `Quality Mismatch! Scanned: ${originalGrade}, Delivered: ${deliveryGrade}. Funds held in dispute.`
            });
        }

    } catch (error) {
        console.error("Verification error:", error.message);
        res.status(500).json({ status: "error", message: "Verification or Disbursement failed" });
    }
});

// ─── 4. RESOLVE DISPUTE (Admin only) ─────────────────────────────────────────
router.post('/resolve-dispute', async (req, res) => {
    const { txRef, resolution, adminSecret } = req.body;

    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ message: "Unauthorized" });
    }

    try {
        const transaction = await Transaction.findOne({ txRef });

        if (!transaction) {
            return res.status(404).json({ status: "error", message: "Transaction not found" });
        }

        if (transaction.status !== 'DISPUTED') {
            return res.status(400).json({
                status:  "error",
                message: `Cannot resolve — transaction is currently ${transaction.status}`
            });
        }

        if (resolution === "ACCEPT_PAYMENT") {
            transaction.status         = 'RELEASED';
            transaction.resolutionNote = "Dispute resolved by Admin: Payment accepted, funds released to farmer.";
            transaction.releasedAt     = new Date();
        } else if (resolution === "REFUND") {
            transaction.status         = 'REFUNDED';
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

// ─── 5. CREATE SCAN RECORD ───────────────────────────────────────────────────
router.post('/scan', async (req, res) => {
    const { farmer, grainType, aiGrade, aiScore, defects, gps } = req.body;

    if (!grainType || !aiGrade) {
        return res.status(400).json({ status: "error", message: "grainType and aiGrade are required" });
    }

    if (!VALID_GRAINS.includes(grainType)) {
        return res.status(400).json({ status: "error", message: `grainType must be one of: ${VALID_GRAINS.join(', ')}` });
    }

    if (!['A', 'B', 'C'].includes(aiGrade)) {
        return res.status(400).json({ status: "error", message: "aiGrade must be A, B, or C" });
    }

    try {
        const marketPriceData = await marketService.getMarketPrice(grainType);

        const scan = await Scan.create({
            farmer:    farmer || {},
            grainType,
            aiGrade,
            aiScore:   aiScore || null,
            defects:   defects || [],
            unitPrice: marketPriceData.price,
            gps:       gps || {},
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

        const honestTrades     = completedTrades.filter(t => t.deliveryMatchOk === true).length;
        const trustScore       = Math.round((honestTrades / totalTrades) * 100);

        let trustGrade;
        if      (trustScore >= 90) trustGrade = 'PLATINUM';
        else if (trustScore >= 75) trustGrade = 'GOLD';
        else if (trustScore >= 50) trustGrade = 'SILVER';
        else                       trustGrade = 'BRONZE';

        let platformFeePercent;
        if      (trustScore >= 90) platformFeePercent = 2;
        else if (trustScore >= 75) platformFeePercent = 3.5;
        else                       platformFeePercent = 5;

        res.json({
            status:            "success",
            phone,
            trustScore,
            grade:             trustGrade,
            totalTrades,
            honestTrades,
            platformFeePercent,
            message: `${trustGrade} farmer — ${trustScore}% delivery accuracy over ${totalTrades} trades.`
        });

    } catch (error) {
        console.error("Trust Score Error:", error);
        res.status(500).json({ status: "error", message: "Could not compute trust score" });
    }
});

// ─── 7. OFFLINE SYNC ─────────────────────────────────────────────────────────
router.post('/sync-offline-scans', async (req, res) => {
    const { scans } = req.body;

    if (!Array.isArray(scans) || scans.length === 0) {
        return res.status(400).json({ status: "error", message: "Provide a non-empty 'scans' array" });
    }

    const results  = [];
    const failures = [];

    for (const raw of scans) {
        if (!raw.grainType || !VALID_GRAINS.includes(raw.grainType) ||
            !raw.aiGrade   || !['A', 'B', 'C'].includes(raw.aiGrade)) {
            failures.push({ raw, reason: "Missing or invalid grainType / aiGrade" });
            continue;
        }

        try {
            const marketPriceData = await marketService.getMarketPrice(raw.grainType);

            const createPayload = {
                farmer:    raw.farmer  || {},
                grainType: raw.grainType,
                aiGrade:   raw.aiGrade,
                aiScore:   raw.aiScore || null,
                defects:   raw.defects || [],
                unitPrice: marketPriceData.price,
                gps:       raw.gps     || {},
            };

            if (raw.scannedAt) createPayload.createdAt = new Date(raw.scannedAt);

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

    res.status(207).json({
        status:  failures.length === 0 ? "success" : "partial",
        synced:  results.length,
        failed:  failures.length,
        results,
        failures,
        message: `${results.length}/${scans.length} scans synced successfully.`
    });
});

// ─── 8. GRADE AND SCAN (Unified AI + Payment pipeline) ───────────────────────
router.post('/grade-and-scan', async (req, res) => {
    const { farmer, grainType, quantity, imageBase64, gps, weatherData } = req.body;

    if (!imageBase64)   return res.status(400).json({ status: "error", message: "imageBase64 is required" });
    if (!grainType)     return res.status(400).json({ status: "error", message: "grainType is required" });
    if (!farmer?.phone) return res.status(400).json({ status: "error", message: "farmer.phone is required" });

    if (!VALID_GRAINS.includes(grainType)) {
        return res.status(400).json({ status: "error", message: `grainType must be one of: ${VALID_GRAINS.join(', ')}` });
    }

    if (quantity && parseFloat(quantity) <= 0) {
        return res.status(400).json({ status: "error", message: "quantity must be a positive number" });
    }

    try {
        // Step 1: Call ML service with 30s timeout to prevent indefinite hangs on cold starts
        let mlData;
        try {
            const mlResponse = await axios.post(
                `${ML_API}/api/grade-grain`,
                {
                    image_base64: imageBase64,
                    farmer_id:    farmer.phone,
                    latitude:     gps?.lat  || null,
                    longitude:    gps?.lng  || null,
                    weather_data: weatherData || {}
                },
                { timeout: 30000 }
            );
            mlData = mlResponse.data;
        } catch (mlErr) {
            console.error("ML Service unreachable:", mlErr.message);
            return res.status(502).json({
                status:  "error",
                message: "AI grading service is unavailable. Please try again.",
            });
        }

        const { grade, quality_score, confidence, breakdown, reasoning } = mlData;

        if (!['A', 'B', 'C'].includes(grade)) {
            return res.status(502).json({ status: "error", message: `ML service returned unexpected grade: ${grade}` });
        }

        // Map ML breakdown into defects array for the Scan schema
        const defects = [];
        if (breakdown?.defect_assessment === 'Medium') defects.push('moderate_defects');
        if (breakdown?.defect_assessment === 'High')   defects.push('significant_defects');
        if (breakdown?.dark_blobs_detected > 0)        defects.push(`blobs_detected:${breakdown.dark_blobs_detected}`);

        // Step 2: Lock in market price and persist scan record
        const marketPriceData = await marketService.getMarketPrice(grainType);
        const unitPrice       = marketPriceData.price;

        const scan = await Scan.create({
            farmer,
            grainType,
            aiGrade:  grade,
            aiScore:  quality_score || null,
            defects,
            unitPrice,
            gps: gps || {},
        });

        // Step 3: Auto-initiate escrow trade if quantity provided
        if (quantity) {
            const qty         = parseFloat(quantity);
            const totalAmount = unitPrice * qty;
            const txRef       = `GT_${Date.now()}`;

            const squadAcc   = await squadService.createGrainVirtualAccount(farmer, txRef);
            const virtualAcc = squadAcc?.virtual_account_number || "9988776655";

            const transaction = await Transaction.create({
                txRef,
                scanId:         scan._id,
                farmer,
                grainType,
                quantity:       qty,
                unitPrice,
                totalAmount,
                virtualAccount: virtualAcc,
                status:         'PENDING',
            });

            return res.status(201).json({
                status: "success",
                ai: {
                    grade,
                    confidence,
                    defects,
                    aiScore:   quality_score,
                    reasoning,
                    breakdown,
                },
                scanId:         scan._id,
                transactionRef: txRef,
                transactionId:  transaction._id,
                priceInfo: {
                    unitPrice:   `₦${unitPrice.toLocaleString()}`,
                    quantity:    `${qty} kg`,
                    totalAmount: `₦${totalAmount.toLocaleString()}`,
                    source:      marketPriceData.source,
                },
                paymentDetails: {
                    bank:          "GTBank (Squad)",
                    accountNumber: virtualAcc,
                    instructions:  `Transfer exactly ₦${totalAmount.toLocaleString()} to secure this trade.`,
                },
            });
        }

        // Grade-only response (no quantity provided)
        res.status(201).json({
            status: "success",
            ai: {
                grade,
                confidence,
                defects: scan.defects,
                aiScore: quality_score,
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
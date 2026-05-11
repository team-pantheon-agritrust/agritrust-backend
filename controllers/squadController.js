const express = require('express');
const router = express.Router();
const squadService = require('../serviceFiles/squadService');
const marketService = require('../serviceFiles/marketService');
const { Transaction, Scan } = require('../db/models'); 

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
    // 1. Log incoming data for debugging during the demo
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

module.exports = router;
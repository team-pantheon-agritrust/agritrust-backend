const mongoose = require('mongoose');

// --- Scan Record ---
// Created when the AI grades a grain sample
const scanSchema = new mongoose.Schema({
    farmer: {
        firstName: String,
        lastName: String,
        phone: String,
        email: String,
    },
    grainType:  { type: String, required: true },   // e.g. "Maize"
    aiGrade:    { type: String, required: true },   // "A", "B", or "C"
    aiScore:    { type: Number },                   // raw confidence score from model
    defects:    { type: [String], default: [] },    // e.g. ["mold", "pest_damage"]
    unitPrice:  { type: Number },                   // price per kg at scan time
    // Anti-fraud metadata (sent by the frontend)
    gps: {
        lat: Number,
        lng: Number,
    },
}, { timestamps: true }); // adds createdAt + updatedAt automatically

// --- Transaction Record ---
// Created when a sale is initiated; updated through the payment lifecycle
const transactionSchema = new mongoose.Schema({
    txRef:      { type: String, required: true, unique: true }, // e.g. "GT_1234567890"
    totalAmount: { type:Number, required: true},
    scanId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Scan' }, // links back to the scan
    farmer: {
        firstName: String,
        lastName: String,
        phone: String,
        email: String,
    },
    grainType:  String,
    quantity:   Number,                 // in kg
    unitPrice:  Number,                 // per kg
    totalAmount: Number,                // unitPrice * quantity
    virtualAccount: String,             // Squad account number

    // Payment lifecycle
    status: {
        type: String,
        enum: ['PENDING', 'PAID', 'DELIVERED', 'RELEASED', 'DISPUTED'],
        default: 'PENDING',
    },

    // Filled in after delivery verification
    deliveryGrade:   String,            // grade the buyer scanned on arrival
    deliveryMatchOk: Boolean,           // true if delivery matched the original scan
    
    paidAt:      Date,
    releasedAt:  Date,
}, { timestamps: true });

const Scan        = mongoose.model('Scan', scanSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = { Scan, Transaction };
# 🌾 GrainTrust Backend (Squad Hackathon 3.0)

GrainTrust is an AI-powered escrow platform that secures grain trades between farmers and buyers using **Computer Vision Quality Analysis** and **Squad Virtual Accounts**.

## 🚀 The "Tight" Logic Flow
1. **AI Scan:** Farmer scans grain; ML model returns a Grade (A/B/C).
2. **Escrow Initiation:** Backend generates a unique Squad Virtual Account.
3. **Buyer Payment:** Buyer pays into the escrow account (Status: `PAID`).
4. **Delivery & Verification:** Buyer scans grain on arrival.
5. **Fund Release:** If Grade matches, Squad releases funds to the farmer.

## 🛠️ Tech Stack
- **Runtime:** Node.js / Express
- **Database:** MongoDB Atlas (Mongoose)
- **Payment Engine:** Squad API (Virtual Accounts & Webhooks)
- **AI Integration:** Computer Vision Micro-Feature Analysis

## 📡 API Endpoints (For Frontend/ML Team)
- `POST /api/squad/initiate-sale` - Creates escrow account & saves transaction.
- `POST /api/squad/webhook` - Listens for Squad payment confirmation.
- `POST /api/squad/verify-delivery` - Compares arrival quality with scan data to release funds.

---
*Built for the Squad Hackathon Challenge 1*
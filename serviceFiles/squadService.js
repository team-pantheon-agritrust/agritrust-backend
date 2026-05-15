const axios = require('axios');

/**
 * Squad API Service for Grain-Trust
 * Environment: Sandbox
 */

const SQUAD_SECRET_KEY = process.env.SQUAD_SECRET_KEY;

const BASE_URL = 'https://sandbox-api-d.squadco.com';

const MERCHANT_ID = 'SB1SPYD3DX';

const headers = {
    Authorization: `Bearer ${SQUAD_SECRET_KEY}`
};

/**
 * Initialize Dynamic Virtual Account Pool
 * Run ONCE during app startup or admin setup.
 */
const initializeDynamicPool = async (numberOfAccounts = 10) => {

    try {

        const response = await axios.post(
            `${BASE_URL}/virtual-account/create-dynamic-virtual-account`,
            {},
            { headers }
        );

        console.log(
            '✅ Dynamic VA Pool Initialized'
        );

        return response.data;

    } catch (error) {

        console.error(
            '❌ Pool Initialization Failed:',
            error.response?.data || error.message
        );

        return null;
    }
};

/**
 * Create Dynamic Virtual Account
 * Used for one-time grain trade escrow payments
 */
const createGrainVirtualAccount = async (
    farmer,
    txRef,
    amount
) => {

    try {

        const amountInKobo = String(
            Math.round(amount * 100)
        );

        const response = await axios.post(
            `${BASE_URL}/virtual-account/initiate-dynamic-virtual-account`,
            {
                transaction_ref: txRef,

                amount: amountInKobo,

                // 24 hours in seconds
                duration: "86400",

                customer_name:
                    `${farmer.firstName} ${farmer.lastName}`,

                email:
                    farmer.email || 'trade@graintrust.com'
            },
            { headers }
        );

        return response.data.data;

    } catch (error) {

        console.warn(
            '⚠️ Dynamic VA Error:',
            error.response?.data || error.message
        );

        /**
         * Demo fallback
         */
        return {
            virtual_account_number: '9988776655',
            bank_name: 'Squad Sandbox Bank',
            account_name:
                `${farmer.firstName} ${farmer.lastName}`,
            expected_amount: amount,
            expires_in: '24 hours'
        };
    }
};

/**
 * Verify Bank Account
 * Mandatory before disbursement
 */
const verifyBankAccount = async (
    accountNumber,
    bankCode
) => {

    try {

        // Validate bank code length
        if (!String(bankCode).match(/^\d{6}$/)) {
            throw new Error(
                'Invalid bank code. Must be 6-digit NIP code.'
            );
        }

        const response = await axios.post(
            `${BASE_URL}/payout/account/lookup`,
            {
                account_number: accountNumber,
                bank_code: bankCode
            },
            { headers }
        );

        return response.data.data;

    } catch (error) {

        console.error(
            '❌ Account Lookup Failed:',
            error.response?.data?.message || error.message
        );

        return null;
    }
};

/**
 * Disburse Funds to Farmer
 */
const disburseToFarmer = async (payoutData) => {

    try {

        const amountInKobo = String(
            Math.round(payoutData.amount * 100)
        );

        const transactionReference =
            `${MERCHANT_ID}_${payoutData.txRef}_${Date.now()}`;

        const response = await axios.post(
            `${BASE_URL}/payout/transfer`,
            {
                transaction_reference:
                    transactionReference,

                amount: amountInKobo,

                currency_id: 'NGN',

                bank_code: payoutData.bankCode,

                account_number:
                    payoutData.accountNumber,

                account_name:
                    payoutData.accountName,

                remark:
                    `Grain-Trust Payout: ${payoutData.txRef}`
            },
            { headers }
        );

        return {
            success: true,
            transaction_reference:
                transactionReference,
            data: response.data
        };

    } catch (error) {

        const errorMsg =
            error.response?.data?.message ||
            error.message;

        console.error(
            '❌ Disbursement Error:',
            errorMsg
        );

        /**
         * Squad timeout handling
         */
        if (error.response?.status === 424) {

            console.warn(
                '⚠️ Transfer timeout detected.'
            );

            console.warn(
                '⚠️ Run requeryTransfer() before retrying.'
            );
        }

        /**
         * Merchant profiling issue
         */
        if (
            errorMsg.toLowerCase().includes('profiled')
        ) {

            console.error(
                '🚨 Enable Transfers in Squad Sandbox Dashboard.'
            );
        }

        throw new Error(
            `Financial disbursement failed: ${errorMsg}`
        );
    }
};

/**
 * Requery Transfer Status
 * Critical after 424 timeout errors
 */
const requeryTransfer = async (
    transactionReference
) => {

    try {

        const response = await axios.post(
            `${BASE_URL}/payout/requery`,
            {
                transaction_reference:
                    transactionReference
            },
            { headers }
        );

        return response.data;

    } catch (error) {

        console.error(
            '❌ Transfer Requery Failed:',
            error.response?.data || error.message
        );

        return null;
    }
};

module.exports = {
    initializeDynamicPool,
    createGrainVirtualAccount,
    verifyBankAccount,
    disburseToFarmer,
    requeryTransfer
};
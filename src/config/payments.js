// Where manual payments (bank transfer / USSD) go. Same account PassNow uses. A payment made this
// way is recorded as PENDING and an admin confirms it from the panel once the money is seen —
// it never activates anything on its own.
//
// Overridable from the environment so the account can change without a code change.
const bank = {
  bankName: process.env.PAY_BANK_NAME || 'Zenith Bank International',
  accountName: process.env.PAY_ACCOUNT_NAME || 'Infopedia Technology',
  accountNumber: process.env.PAY_ACCOUNT_NUMBER || '1016980625',
  // Zenith EazyBanking USSD: *966*<amount>*<account number>#
  ussd: (amountNaira) => `*966*${Math.round(amountNaira)}*${process.env.PAY_ACCOUNT_NUMBER || '1016980625'}#`,
};

// The Flutterwave PUBLIC key is meant to be in the browser (it can only start a checkout);
// the secret key and webhook hash stay on the server. Leave FLUTTERWAVE_PUBLIC_KEY unset to hide
// the card/USSD popup and offer bank transfer only.
const flutterwavePublicKey = () => process.env.FLUTTERWAVE_PUBLIC_KEY || null;

module.exports = { bank, flutterwavePublicKey };

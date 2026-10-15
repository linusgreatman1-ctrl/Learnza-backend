// While Learnza is being tested, every payment is accepted at once (a plan starts and coins are added the moment the "pay" button is
// pressed, with no money moving). Before launch set PAYMENTS_AUTO_APPROVE=false on the server and payments become real: card
// payments are confirmed by the provider, bank transfers by the bank-credit feed or by an admin.
const autoApprove = () => process.env.PAYMENTS_AUTO_APPROVE !== 'false';

module.exports = { autoApprove };

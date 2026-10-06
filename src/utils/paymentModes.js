// The one place that decides which payment modes actually move a bank balance.
//
// `Payment.paymentMode` / `Expense.paymentMode` both enumerate
// Cash | Bank | UPI | Cheque. Everything except Cash is money moving through a
// bank account, so all three debit/credit the selected BankAccount:
//
//   - UPI is a bank transfer with a different rail — treating it as cash
//     understates the bank balance and silently breaks reconciliation.
//   - A Cheque posts on the day it is handed over. This project has no
//     clearance/pending concept anywhere (no status field on Payment or
//     Expense, nothing that could later mark a cheque cleared or bounced), so
//     holding it off the balance would mean it never lands at all.
//
// This lives in utils/ rather than being repeated per controller because six
// controllers act on it — payment, expense, purchase, sale, purchaseReturn and
// saleReturn — and an accounting rule with six copies is a rule that drifts.
// If a fifth mode (card, wallet) is ever added, it is decided here once.
const BANK_BACKED_MODES = ["Bank", "Cheque", "UPI"];

function usesBankAccount(paymentMode) {
  return BANK_BACKED_MODES.includes(paymentMode);
}

module.exports = {
  BANK_BACKED_MODES,
  usesBankAccount,
};

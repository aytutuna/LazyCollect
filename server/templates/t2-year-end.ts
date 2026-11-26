// T2 corporate year-end. Checked 2026-11 against:
// - T5 slips and summary, due the last day of February, none needed under $50 per recipient: canada.ca/en/revenue-agency/services/forms-publications/publications/t4015/t5-guide-return-investment-income.html
// - shareholder loans, subsection 15(2): canada.ca Income Tax Folio S3-F1-C1, Shareholder Loans and Debts
import { ask, doc, template, text } from "./build";

const assets = "Did the corporation buy or sell equipment, vehicles or property this year?";
const loans = "Did a shareholder borrow from the corporation or lend it money?";
const payroll = "Did the corporation pay salaries or wages?";
const dividends = "Did the corporation pay dividends?";
const gst = "Is the corporation registered for GST/HST?";
const minutes = "Were there changes to directors, officers or shareholders, or new shares issued?";

export default template("t2-year-end", "T2 corporate year-end", [
  doc("Trial balance or bookkeeping file", "An export from your accounting software, or the spreadsheet you keep."),
  doc("Bank statements for every month of the year", "All business accounts, January to the last month of the year end.", undefined, true, "bank-statement"),
  doc("Credit card statements for every month of the year", "All business cards."),
  doc("T2 return and notice of assessment for {year-1}", "The filed return and the CRA's notice, if we did not prepare them."),
  doc("Loan and mortgage statements", "Year-end balance and interest paid.", undefined, false),

  ask(assets),
  doc("Invoices for equipment, vehicles or property bought", "The date, the amount and what was bought.", assets, false),
  doc("Sale documents for assets sold", "The date, the price and what was sold.", assets, false),

  ask(loans),
  doc("Shareholder loan account", "A loan not repaid by the end of the year after the one in which it was made may be taxable to the shareholder. Tell us the date and amount of each loan and repayment.", loans),

  ask(payroll),
  doc("Payroll summary for the year", "From your payroll software or provider.", payroll),
  doc("T4 summary and T4 slips", "Filed by the last day of February.", payroll),

  ask(dividends),
  doc("T5 slips and T5 summary", "Filed by the last day of February. No slip is needed for amounts under $50 per person.", dividends),
  doc("Dividend resolutions", "The directors' resolution for each dividend.", dividends, false),

  ask(gst),
  doc("GST/HST returns filed this year", "Or the confirmation for each period.", gst),

  ask(minutes),
  doc("Minute book updates", "Resolutions, the share register and any change of directors or officers.", minutes),

  doc("Receipts for large or unusual expenses", undefined, undefined, false),
  text("Anything unusual this year?", "For example a new loan, a grant, a sale of part of the business, or a new owner.", undefined, false, "longtext"),
]);

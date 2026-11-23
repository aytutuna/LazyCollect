// GST/HST return period. Checked 2026-11 against:
// - records kept six years, with seller GST/HST numbers on purchases: canada.ca/en/revenue-agency/services/tax/businesses/topics/sole-proprietorships-partnerships/business-records.html
// - input tax credit documents, $100 and $500 thresholds (raised from $30/$150 in 2021): Input Tax Credit Information (GST/HST) Regulations, SOR/91-45 s. 3, laws-lois.justice.gc.ca/eng/regulations/SOR-91-45/page-1.html
// - the combined GST/HST and QST return and QST registrants: revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/reporting-gsthst-and-qst/filing-frequency/
//   (Revenu Quebec refused automated fetches, so this one comes from its search listing)
import { ask, doc, template } from "./build";

const qst = "Are you registered for the Quebec sales tax (QST)?";
const credit = "Did you issue credit notes or write off any unpaid invoices in this period?";

export default template("gst-hst-return", "GST/HST return period", [
  doc("Sales records for the period", "A sales report or invoice list. Show taxable, zero-rated and exempt sales separately if you can."),
  doc("Purchase and expense records for the period", "Receipts and supplier invoices for input tax credits. Receipts of $100 or more need the seller's GST/HST number; $500 or more also need your name and a description of what you bought."),
  doc("Bank statements for the period", "To check the deposits against your sales.", undefined, false),

  ask(credit),
  doc("Credit notes or write-off list", undefined, credit),

  ask(qst, "Revenu Québec handles QST. It can be filed with the GST/HST on one combined return."),
  doc("QST collected and paid for the period", "The sales tax report from your accounting software, with the QST amounts.", qst),

  doc("Notices from the CRA or Revenu Québec", "Anything received since the last return.", undefined, false),
]);

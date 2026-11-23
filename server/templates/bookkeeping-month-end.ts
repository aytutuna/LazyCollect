// Bookkeeping month-end. No tax rules in this one, so there is nothing to check against an official page. Checked 2026-11.
import { ask, doc, template, text } from "./build";

const payroll = "Did you run payroll this month?";
const big = "Did you take out a loan, buy equipment, or put in or take out owner money this month?";

export default template("bookkeeping-month-end", "Bookkeeping month-end", [
  doc("Bank statements for the month", "Every business account, as a PDF from your bank.", undefined, true, "bank-statement"),
  doc("Credit card statements for the month", "Every business card."),
  doc("Sales invoices issued", "A list from your invoicing system, or copies of the invoices."),
  doc("Receipts for expenses paid", "Photos are fine. Include anything paid in cash or on a personal card."),

  ask(payroll),
  doc("Payroll report for the month", "From your payroll software or provider.", payroll),

  ask(big, "For example a new loan, a vehicle, a computer, or money you moved between yourself and the business."),
  text("What happened, and on what date?", undefined, big, true, "longtext"),

  doc("Cash sales not on an invoice", "Daily sales sheets or till reports.", undefined, false),
  text("Anything we should know about this month?", undefined, undefined, false, "longtext"),
]);

// Express Entry, permanent residence application after an invitation to apply. Checked 2026-11 against:
// - apply for permanent residence: canada.ca/en/immigration-refugees-citizenship/services/immigrate-canada/express-entry/apply-permanent-residence.html
// - proof of funds, with the amounts and what the bank letter must say: .../express-entry/documents/proof-funds.html
// The invitation is valid for 60 days and the portal builds a personalized checklist; only upload what it lists.
// The police certificate rule for Express Entry could not be read, so the help points to the checklist.
import { ask, doc, template, text } from "./build";

const education = "Did you get your highest education outside Canada?";
const exempt = "Are you exempt from showing proof of funds (Canadian Experience Class, or working in Canada with a valid job offer)?";
const offer = "Do you have a job offer from a Canadian employer?";
const nominated = "Did a province or territory nominate you?";
const partner = "Do you have a spouse or common-law partner?";
const children = "Do you have dependent children?";
const lived = "Have you lived in a country other than Canada for 6 months or more since you turned 18?";
const translated = "Are any of your documents in a language other than English or French?";

export default template("ircc-express-entry", "Express Entry: permanent residence after an invitation", [
  doc("Invitation to Apply and profile number", "From your Express Entry account. The invitation is valid for 60 days."),
  doc("Passport", "The page with your photo and details, and any pages with visas or stamps. If it expires within 6 months, renew it first.", undefined, true, "passport"),
  doc("Language test results", "The results you used for your profile, from an approved test such as IELTS, CELPIP, TEF or TCF."),
  ask(education),
  doc("Educational credential assessment (ECA)", "The report from an approved organization.", education),
  doc("Degrees, diplomas and transcripts", "For the education you claimed points for."),
  doc("Work reference letters", "On company letterhead, with your job title, duties, hours per week, pay, dates, and the supervisor's name and contact details."),
  ask(exempt, "If you are exempt, you do not send proof of funds."),
  doc("Proof of funds", "A letter from each bank on letterhead with its contact details, your name, and for each account the number, date opened, current balance and average balance for the last 6 months. IRCC's 2025 minimum for one person was C$15,263; check the current table.", [exempt, "no"], true, "bank-statement"),
  ask(offer),
  doc("Job offer", "The signed offer letter, if you claimed points for it or you are using it to skip proof of funds.", offer, false),
  ask(nominated),
  doc("Provincial nomination", "The nomination certificate.", nominated),
  ask(lived, "Most applicants need police certificates."),
  doc("Police certificates", "From each country where you lived 6 months or more since you turned 18. Your IRCC checklist says exactly which.", lived),
  doc("Medical exam receipt", "Book one visit with a panel physician and send the eMedical information sheet. Family members need an exam too, even if they will not come."),
  ask(partner),
  doc("Spouse or partner documents", "Passport, marriage certificate or common-law declaration (IMM 5409), and any police certificates and language or education documents your checklist lists.", partner),
  ask(children),
  doc("Children's birth certificates", "Showing both parents. Add passports if your checklist lists them.", children),
  doc("Family information form", "IMM 5406 and the background forms are completed in your IRCC account. Send anything your representative asks for here.", undefined, false),
  doc("Digital photos", "Only if your IRCC checklist lists them.", undefined, false),
  ask(translated),
  doc("Certified translations", "Send a scan of the original and the certified English or French translation.", translated),
  doc("Signed Use of a Representative form (IMM 5476)", "Only if someone is helping you with the application.", undefined, false),
  text("Anything else we should know?", "Name changes, gaps in work or anything that is not clear.", undefined, false, "longtext"),
]);

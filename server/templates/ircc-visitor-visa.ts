// Visitor visa (temporary resident visa). Checked 2026-11 against:
// - how to apply: canada.ca/en/immigration-refugees-citizenship/services/visit-canada/apply-visitor-visa.html
// The page says the passport must be valid at least 6 months from the travel date and that the personalized checklist decides the rest.
// IRCC's own kits disagree on how many months of bank statements to send, so the help points to the checklist.
import { ask, doc, template, text } from "./build";

const invited = "Is someone in Canada inviting you?";
const abroad = "Are you applying from a country other than the one that issued your passport?";
const lived = "Have you lived in a country other than Canada for 6 months or more since you turned 18?";
const translated = "Are any of your documents in a language other than English or French?";

export default template("ircc-visitor-visa", "Visitor visa", [
  doc("Passport", "The page with your photo and details, and any pages with visas or stamps. It must be valid for at least 6 months after you travel.", undefined, true, "passport"),
  doc("Digital photo", "Meeting IRCC photo specifications."),
  doc("Proof of funds", "Recent bank statements, usually the last 6 months, with balances and the bank's contact details. Your IRCC checklist may ask for a different period.", undefined, true, "bank-statement"),
  doc("Travel itinerary", "Dates, places you will stay and the reason for the trip."),
  doc("Employment letter or proof of enrolment", "On letterhead, dated within the last 3 months, signed by a manager or HR. Students send a letter from the school."),
  doc("Travel history", "Visas and stamps from the last 10 years.", undefined, false),
  ask(invited, "A family member, a friend or a business."),
  doc("Invitation letter", "Signed by the host, with their address and how you know each other.", invited),
  doc("Host's status in Canada and address", "A copy of their passport, PR card, citizenship certificate or permit.", invited),
  doc("Proof of relationship to your host", "A marriage or birth certificate, or a declaration of common-law union (IMM 5409).", invited, false),
  ask(abroad, "IRCC asks for proof of your status where you live."),
  doc("Proof of status where you live", "Your permit or visa for that country.", abroad),
  ask(lived, "IRCC asks for police certificates only in some cases."),
  doc("Police certificate", "From each country where you lived 6 months or more, only if IRCC asks for one.", lived, false),
  doc("Medical exam receipt", "Only if IRCC asks for one, for example for a long stay or recent time in some countries.", undefined, false),
  ask(translated),
  doc("Certified translations", "Send the original and the English or French translation. Unless the translator is certified in Canada, add the translator's affidavit.", translated),
  doc("Signed Use of a Representative form (IMM 5476)", "Only if someone is helping you with the application.", undefined, false),
  text("Anything else we should know?", "Previous refusals, or anything that is not clear.", undefined, false, "longtext"),
]);

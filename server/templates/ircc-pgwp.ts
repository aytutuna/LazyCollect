// Post-graduation work permit (PGWP). Checked 2026-11 against:
// - how to apply: canada.ca/en/immigration-refugees-citizenship/services/study-canada/work/after-graduation/apply.html
// - eligibility: .../work/after-graduation/eligibility.html
// - field of study: .../work/after-graduation/eligibility/field-of-study.html
// - language results (level 7 for university, 5 for college): .../work/after-graduation/eligibility/language-results.html
// The apply page does not list transcripts or a completion letter, so those items follow common practice; the portal checklist decides.
import { ask, doc, template, text } from "./build";

const newRules = "Did you submit your study permit application on or after November 1, 2024?";
const expired = "Has your study permit already expired?";
const lived = "Have you lived in a country other than Canada for 6 months or more since you turned 18?";
const translated = "Are any of your documents in a language other than English or French?";

export default template("ircc-pgwp", "Post-graduation work permit (PGWP)", [
  doc("Passport", "The page with your photo and details, and any pages with visas or stamps. One file.", undefined, true, "passport"),
  doc("Study permit", "Your current permit, and earlier ones if you had more than one."),
  doc("Official transcript", "From your school, showing the whole program."),
  doc("Letter or certificate showing you completed your program", "The school's letter, or your degree, diploma or certificate once you have it. Apply within 180 days of the school confirming you completed."),
  ask(newRules, "The language and field of study rules depend on this date."),
  doc("Language test results", "Needed if your program required one. A university program needs level 7 in all four skills, a college program level 5.", newRules),
  doc("Proof your program is in an eligible field of study", "Needed only if your program is not a bachelor's, master's or doctoral degree. IRCC has a list of eligible fields.", newRules, false),
  ask(expired, "If it expired, you can ask to restore your status within 90 days."),
  doc("Letter of explanation for the expired permit", "The date it expired, and why the application is late.", expired),
  doc("Digital photo", "Only if your IRCC checklist asks for one.", undefined, false),
  ask(lived, "IRCC asks for police certificates only in some cases."),
  doc("Police certificate", "From each country where you lived 6 months or more, only if IRCC asks for one.", lived, false),
  doc("Medical exam receipt", "Only if IRCC asks for one.", undefined, false),
  ask(translated),
  doc("Certified translations", "Send the original and the English or French translation. Unless the translator is certified in Canada, add the translator's affidavit.", translated),
  doc("Signed Use of a Representative form (IMM 5476)", "Only if someone is helping you with the application.", undefined, false),
  text("Anything else we should know?", "A leave of absence, a program change or anything that is not clear.", undefined, false, "longtext"),
]);

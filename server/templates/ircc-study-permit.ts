// Study permit application from outside Canada. Checked 2026-11 against:
// - guide 5269: canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/guide-5269-applying-study-permit-outside-canada.html
// - documents: canada.ca/en/immigration-refugees-citizenship/services/study-canada/study-permit/get-documents.html
// - provincial attestation letter and its exemptions: .../study-permit/get-documents/provincial-attestation-letter.html
// - proof of funds, amounts for applications from September 1, 2026: .../study-permit/get-documents/financial-support.html
// The checklist the applicant's own IRCC account produces decides what is needed. More notes in IRCC-SOURCES.md.
import { ask, doc, template, text } from "./build";

const quebec = "Will you study in Quebec?";
const pal = "Did your school or province give you a provincial or territorial attestation letter (PAL or TAL)?";
const minor = "Are you a minor where you will study (under the age of majority there)?";
const family = "Will your spouse, partner or children come with you or apply with you?";
const abroad = "Are you applying from a country other than the one that issued your passport?";
const lived = "Have you lived in a country other than Canada for 6 months or more since you turned 18?";
const translated = "Are any of your documents in a language other than English or French?";

export default template("ircc-study-permit", "Study permit, applying from outside Canada", [
  doc("Passport", "The page with your photo and details, and any pages with visas or stamps. One file.", undefined, true, "passport"),
  doc("Letter of acceptance", "From your designated learning institution (DLI). A post-secondary school must confirm it with IRCC."),
  ask(quebec, "Quebec has its own acceptance certificate instead of the attestation letter."),
  doc("Quebec acceptance certificate (CAQ)", "Issued by Quebec's immigration ministry.", quebec),
  ask(pal, "Most applicants need one, issued for the current year. Quebec applicants need the CAQ instead."),
  doc("Provincial attestation letter (PAL or TAL)", "It must be valid on the day you apply.", pal),
  doc("Proof you do not need a PAL", "For example a master's or doctoral program at a public school, or primary or secondary school. Skip this if you study in Quebec.", [pal, "no"], false),
  doc("Proof of funds", "Living costs for one person, outside Quebec, are C$23,448 a year for applications from September 1, 2026, plus your first year of tuition and travel. Bank statements for the last 6 months, a Canadian GIC or a scholarship letter. Explain any large deposit.", undefined, true, "bank-statement"),
  doc("Letter of explanation or study plan", "IRCC recommends one: why this program, why Canada, and what you will do afterwards.", undefined, false),
  doc("Previous diplomas and transcripts", "They show you meet the program's entry requirements."),
  doc("Digital photo", "Only if your IRCC checklist asks for one. People who give biometrics usually do not send paper photos.", undefined, false),
  ask(abroad, "IRCC asks for proof of your status where you live."),
  doc("Proof of status where you live", "Your permit or visa for that country.", abroad),
  ask(minor, "The age depends on the province."),
  doc("Custodianship declaration", "Form IMM 5646, signed by the custodian in Canada and the parents.", minor),
  doc("Custodian's passport or status in Canada", "A copy of the custodian's passport, PR card or citizenship certificate.", minor),
  ask(family),
  doc("Family members' passports and civil documents", "Passport, marriage certificate or common-law declaration (IMM 5409) and birth certificates for each person.", family),
  ask(lived, "IRCC asks for police certificates only in some cases."),
  doc("Police certificate", "From each country where you lived 6 months or more, only if IRCC asks for one.", lived, false),
  doc("Medical exam receipt", "Needed if you will stay more than 6 months or lived in certain countries recently. Book it with a panel physician after IRCC tells you.", undefined, false),
  ask(translated),
  doc("Certified translations", "Send the original and the English or French translation. Unless the translator is certified in Canada, add the translator's affidavit. You and your family cannot translate your own documents.", translated),
  doc("Signed Use of a Representative form (IMM 5476)", "Only if someone is helping you with the application.", undefined, false),
  text("Anything else we should know?", "Refusals, previous permits or anything that is not clear.", undefined, false, "longtext"),
]);

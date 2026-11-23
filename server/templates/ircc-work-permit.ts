// Employer-specific work permit, applying from outside Canada. Checked 2026-11 against:
// - forms and documents: canada.ca/en/immigration-refugees-citizenship/services/work-canada/permit-outside/forms-documents.html
// - guide 5487: canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/guide-5487-applying-work-permit-outside-canada.html
// An open work permit needs far less; IRCC asks for a page marked "Not applicable" in the employment slots. More notes in IRCC-SOURCES.md.
import { ask, doc, template, text, tag } from "./build";

const lmia = "Is the job offer based on a positive LMIA?";
const quebec = "Will the job be in Quebec and last more than 30 days?";
const family = "Will your spouse, partner or children apply with you?";
const abroad = "Are you applying from a country other than the one that issued your passport?";
const translated = "Are any of your documents in a language other than English or French?";

export default template("ircc-work-permit", "Work permit, employer-specific, from outside Canada", [
  tag(doc("Passport", "The page with your photo and details, and any pages with visas or stamps. One file.", undefined, true, "passport"), { per_person: "everyone", expiry: "expiry" }),
  ask(lmia, "A job that needs a labour market impact assessment (LMIA) has a positive LMIA from the employer."),
  doc("Positive LMIA", "A copy of the employer's LMIA decision letter.", lmia),
  text("LMIA number", "The file number printed on the LMIA.", lmia),
  text("Offer of employment number", "The employer pays a fee and gets a number: the letter A and 7 digits. It can be used only once.", [lmia, "no"]),
  doc("Job offer letter", "Signed by the employer, with the job title, duties, pay and start date."),
  doc("Employment contract", "Signed by both you and the employer."),
  doc("Resume", "Up to date, with dates and employers."),
  doc("Proof of work history", "Reference letters from past employers and pay slips."),
  doc("Education documents", "Degrees, diplomas, licences or training the job asks for. If none apply, send a page that says Not applicable."),
  ask(quebec),
  doc("Quebec acceptance certificate (CAQ)", "Issued by Quebec's immigration ministry. The employer usually starts it.", quebec),
  tag(doc("Digital photo", "Meeting IRCC photo specifications.", undefined, false), { per_person: "everyone" }),
  ask(abroad, "IRCC asks for proof of your status where you live."),
  doc("Proof of status where you live", "Your permit or visa for that country.", abroad),
  ask(family),
  doc("Family members' passports and civil documents", "Passport, marriage certificate or common-law declaration (IMM 5409) and birth certificates for each person.", family),
  tag(doc("Police certificate", "From each country where they lived 6 months or more, only if IRCC asks for one.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  tag(doc("Medical exam receipt", "Needed for some jobs and countries. Book it with a panel physician after IRCC tells you.", undefined, false), { per_person: "everyone", expiry: "issue", valid_months: 12 }),
  ask(translated),
  doc("Certified translations", "Send the original and the English or French translation. Unless the translator is certified in Canada, add the translator's affidavit.", translated),
  doc("Signed Use of a Representative form (IMM 5476)", "Only if someone is helping you with the application.", undefined, false),
  text("Anything else we should know?", "Previous refusals or permits, or anything that is not clear.", undefined, false, "longtext"),
]);

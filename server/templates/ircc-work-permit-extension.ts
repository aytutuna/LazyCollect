// Work permit extension or change of conditions, applying from inside Canada. Checked 2026-11 against:
// - forms and documents: canada.ca/en/immigration-refugees-citizenship/services/work-canada/permit-inside/forms-documents.html
// - guide 5553: canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/guide-5553-applying-change-conditions-extend-your-stay-canada-worker.html
// A spousal open work permit has its own documents and is not covered here.
import { ask, doc, template, text, tag } from "./build";

const lmia = "Is the job offer based on a positive LMIA?";
const quebec = "Will the job be in Quebec and last more than 30 days?";
const expired = "Has your work permit already expired?";
const family = "Are your spouse, partner or children applying with you?";
const translated = "Are any of your documents in a language other than English or French?";

export default template("ircc-work-permit-extension", "Work permit extension, from inside Canada", [
  tag(doc("Passport", "The page with your photo and details, the pages with your most recent entry stamp, and any visas. One file.", undefined, true, "passport"), { per_person: "everyone", expiry: "expiry" }),
  doc("Current work permit", "And earlier permits if you had any. IRCC wants to see your status."),
  ask(expired, "If it expired, you can ask to restore your status within 90 days. Next time, apply at least 30 days before the expiry date."),
  doc("Letter of explanation for the expired permit", "The date it expired, and why the application is late.", expired),
  ask(lmia, "A job that needs a labour market impact assessment (LMIA) has a positive LMIA from the employer."),
  doc("Positive LMIA", "A copy of the employer's LMIA decision letter.", lmia),
  text("LMIA number", "The file number printed on the LMIA.", lmia),
  text("Offer of employment number", "The employer pays a fee and gets a number: the letter A and 7 digits. It can be used only once.", [lmia, "no"]),
  doc("Job offer letter", "Signed by the employer, with the job title, duties, pay and start date."),
  doc("Employment contract", "Signed by both you and the employer."),
  doc("Resume", "Up to date, with dates and employers."),
  doc("Proof of work history", "Recent pay slips and reference letters from your Canadian employers."),
  doc("Education documents", "Degrees, diplomas, licences or training the job asks for. If none apply, send a page that says Not applicable."),
  ask(quebec),
  doc("Quebec acceptance certificate (CAQ)", "Issued by Quebec's immigration ministry. The employer usually starts it.", quebec),
  tag(doc("Digital photo", "Meeting IRCC photo specifications.", undefined, false), { per_person: "everyone" }),
  ask(family),
  doc("Family members' passports and civil documents", "Passport, current permit, marriage certificate or common-law declaration (IMM 5409) and birth certificates for each person.", family),
  tag(doc("Police certificate", "From each country where they lived 6 months or more, only if IRCC asks for one.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  tag(doc("Medical exam receipt", "Only if IRCC asks for one.", undefined, false), { per_person: "everyone", expiry: "issue", valid_months: 12 }),
  ask(translated),
  doc("Certified translations", "Send the original and the English or French translation. Unless the translator is certified in Canada, add the translator's affidavit.", translated),
  doc("Signed Use of a Representative form (IMM 5476)", "Only if someone is helping you with the application.", undefined, false),
  text("Anything else we should know?", "Gaps in work, changes of employer or anything that is not clear.", undefined, false, "longtext"),
]);

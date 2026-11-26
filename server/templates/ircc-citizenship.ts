// Canadian citizenship application, adult. Checked 2026-11 against:
// - forms and documents: canada.ca/en/immigration-refugees-citizenship/services/canadian-citizenship/adult-minor/how/adult-forms-documents.html
// - document checklist CIT 0007: canada.ca/content/dam/ircc/documents/pdf/english/kits/forms/cit0007/01-03-2024/cit0007e.pdf (that version may be replaced)
// IRCC checks tax filing with the CRA, so the notices of assessment are optional. The online account lists the documents for the applicant.
import { ask, doc, template, text, tag } from "./build";

const adult = "Are you between 18 and 54 years old?";
const renamed = "Has your name or date of birth changed since it was on your PR card?";
const translated = "Are any of your documents in a language other than English or French?";

export default template("ircc-citizenship", "Citizenship application (adult)", [
  doc("PR card", "Front and back in one file. If you have no PR card or it is not valid, say so in the notes."),
  tag(doc("Passport pages", "Color copies of your passports and travel documents for the whole period you are counting, so IRCC can check your days in Canada.", undefined, true, "passport"), { per_person: "everyone" }),
  doc("Physical presence calculation", "From your IRCC account or IRCC's calculator: you need at least 1,095 days in Canada in the 5 years before you apply."),
  ask(adult, "Language proof is needed between these ages."),
  doc("Language proof", "A diploma or transcript in English or French, an accepted test result (CELPIP-G, CELPIP-LS, IELTS General, PTE Core, TEF, TCF), or a LINC or CLIC certificate.", adult),
  doc("Government ID", "Two pieces of ID that show your name and date of birth. At least one must have your photo."),
  tag(doc("Digital photos", "Meeting IRCC photo specifications. A paper application takes two identical printed photos."), { per_person: "everyone" }),
  tag(doc("Police certificates", "From each country outside Canada where they lived 183 days or more in a row in the past 4 years, after turning 18. Issued after the last time they were in that country, or no more than 6 months before the application is signed.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  ask(renamed),
  doc("Name change evidence", "Marriage certificate, court order or the official document that changed it.", renamed),
  doc("Notices of Assessment", "IRCC checks tax filing with the CRA. Send these only if your representative asks.", undefined, false, "noa"),
  doc("Fee payment receipt", "The receipt from the online payment."),
  ask(translated),
  doc("Certified translations", "Send the original and the English or French translation, from a translator who belongs to a Canadian translators' organization, or with the translator's affidavit.", translated),
  doc("Signed Use of a Representative form (IMM 5476)", "Only if someone is helping you with the application.", undefined, false),
  text("Anything else we should know?", "Long trips, time outside Canada or anything that is not clear.", undefined, false, "longtext"),
]);

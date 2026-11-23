// Express Entry, permanent residence application after an invitation to apply. Checked 2026-11 against:
// - apply for permanent residence: canada.ca/en/immigration-refugees-citizenship/services/immigrate-canada/express-entry/apply-permanent-residence.html
// - proof of funds, with the amounts and what the bank letter must say: .../express-entry/documents/proof-funds.html
// The invitation is valid for 60 days and the portal builds a personalized checklist; only upload what it lists.
// The police certificate rule for Express Entry could not be read, so the help points to the checklist.
import { ask, doc, template, text, tag } from "./build";

const education = "Did you get your highest education outside Canada?";
const exempt = "Are you exempt from showing proof of funds (Canadian Experience Class, or working in Canada with a valid job offer)?";
const offer = "Do you have a job offer from a Canadian employer?";
const nominated = "Did a province or territory nominate you?";
const partner = "Do you have a spouse or common-law partner?";
const children = "Do you have dependent children?";
const translated = "Are any of your documents in a language other than English or French?";

export default template("ircc-express-entry", "Express Entry: permanent residence after an invitation", [
  doc("Invitation to Apply and profile number", "From your Express Entry account. The invitation is valid for 60 days."),
  tag(doc("Passport", "The page with your photo and details, and any pages with visas or stamps. If it expires within 6 months, renew it first.", undefined, true, "passport"), { per_person: "everyone", expiry: "expiry" }),
  doc("Language test results", "The results you used for your profile, from an approved test such as IELTS, CELPIP, TEF or TCF."),
  ask(education),
  doc("Educational credential assessment (ECA)", "The report from an approved organization.", education),
  tag(doc("Degrees, diplomas and transcripts", "For the education you claimed points for."), { translation: true }),
  doc("Work reference letters", "On company letterhead, with your job title, duties, hours per week, pay, dates, and the supervisor's name and contact details."),
  ask(exempt, "If you are exempt, you do not send proof of funds."),
  doc("Letter explaining your exemption (Canadian Experience Class, or authorized to work in Canada with a valid job offer)", "Say which exemption applies and attach what shows it, such as your work permit and job offer.", [exempt, "yes"]),
  doc("Proof of funds", "A letter from each bank on letterhead with its contact details, your name, and for each account the number, date opened, current balance and average balance for the last 6 months. The minimum depends on your family size, including family members who will not come with you. For one person IRCC lists C$15,263 (updated July 7, 2025); check the current table.", [exempt, "no"], true, "bank-statement"),
  ask(offer),
  doc("Job offer", "The signed offer letter, if you claimed points for it or you are using it to skip proof of funds.", offer, false),
  ask(nominated),
  doc("Provincial nomination", "The nomination certificate.", nominated),
  tag(doc("Police certificates", "For each country where they lived 6 months in a row or longer in the last 10 years, after turning 18. From the country where they live now: issued no more than 6 months before you apply. From a country they left: issued after their last stay there. An officer may ask for more.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  tag(doc("Medical exam receipt", "Book one visit with a panel physician and send the eMedical information sheet. Family members need an exam too, even if they will not come. Your medical results letter shows when it expires. It must still be valid when you enter Canada."), { per_person: "everyone", expiry: "issue", valid_months: 12 }),
  ask(partner),
  doc("Spouse or partner documents", "Passport, marriage certificate or common-law declaration (IMM 5409), and any police certificates and language or education documents your checklist lists.", partner),
  ask(children),
  doc("Children's birth certificates", "Showing both parents. Add passports if your checklist lists them.", children),
  doc("Family information form", "IMM 5406 and the background forms are completed in your IRCC account. Send anything your representative asks for here.", undefined, false),
  tag(doc("Digital photos", "Only if your IRCC checklist lists them.", undefined, false), { per_person: "everyone" }),
  ask(translated),
  doc("Certified translations", "Send a scan of the original and the certified English or French translation.", translated),
  doc("Signed Use of a Representative form (IMM 5476)", "Only if someone is helping you with the application.", undefined, false),
  text("Anything else we should know?", "Name changes, gaps in work or anything that is not clear.", undefined, false, "longtext"),
]);

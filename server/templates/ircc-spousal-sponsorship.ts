// Spousal or common-law sponsorship, from inside or outside Canada. Checked 2026-11 against:
// - complete guide: canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/guide-5289-sponsor-your-spouse-common-law-partner-conjugal-partner-dependent-child-complete-guide.html
// The relationship forms (IMM 0008, 5669, 5406) are filled in inside the IRCC portal, so they are not items here.
// IRCC sets no minimum income for sponsoring a spouse or partner. The guide's last section could not be read, so inland extras are limited to proof of status.
import { ask, doc, template, text, tag } from "./build";

const married = "Are you and your partner legally married?";
const inCanada = "Is the person being sponsored living in Canada now?";
const before = "Has either of you been married before?";
const children = "Do you have dependent children?";
const translated = "Are any of your documents in a language other than English or French?";

export default template("ircc-spousal-sponsorship", "Spousal or common-law sponsorship", [
  tag(doc("Passport", "The page with the photo and details, and any pages with visas or stamps. One file for each person.", undefined, true, "passport"), { per_person: "everyone", expiry: "expiry" }),
  doc("Signed sponsorship forms (IMM 1344 and IMM 5532)", "Your representative gives you these to sign. Both of you sign the sponsorship application."),
  doc("Sponsor's PR card or citizenship certificate", "Front and back, or the certificate."),
  ask(married, "Say no if you live together as common-law partners."),
  doc("Marriage certificate", "It must show the marriage was registered. A record of solemnization or a marriage licence alone is not accepted.", married),
  doc("Declaration of common-law union (IMM 5409)", "Signed by both of you.", [married, "no"]),
  doc("Proof you have lived together for 12 months or more", "Joint lease, bills or letters addressed to you both at the same address.", [married, "no"]),
  doc("Photos together over time", "A few from different years and places, with dates if you know them."),
  doc("Chats, calls and messages", "A selection that shows regular contact over time. You do not need to send everything.", undefined, false),
  doc("Travel history together", "Tickets, boarding passes or stamps from trips you took together.", undefined, false),
  doc("Joint bank accounts, leases or bills", "Anything that shows shared money or a shared home.", undefined, false),
  doc("Sponsor's income documents", "IRCC sets no minimum income for sponsoring a spouse or partner, so send these only if your representative asks.", undefined, false),
  ask(inCanada, "For a partner in Canada, IRCC checks their temporary status."),
  doc("Proof of the applicant's status in Canada", "Their permit, visitor record or other document, and any receipt for an extension.", inCanada),
  ask(before),
  doc("Divorce or death certificate", "For each earlier marriage or common-law union, for either of you.", before),
  ask(children),
  doc("Children's birth certificates and IDs", "Birth certificates showing the parents, and a passport or ID for each child.", children),
  tag(doc("Police certificates", "From each country where they lived 6 months or more in a row since turning 18. Get the certificate after you leave that country, or within the time IRCC allows.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  tag(doc("Medical exam receipt", "After IRCC tells you to, book with a panel physician. Each person needs an exam, including children.", undefined, false), { per_person: "everyone", expiry: "issue", valid_months: 12 }),
  tag(doc("Digital photos", "Meeting IRCC photo specifications.", undefined, false), { per_person: "everyone" }),
  doc("Fee payment receipt", "The receipt from the online payment."),
  ask(translated),
  doc("Certified translations", "Send the original and the English or French translation. Unless the translator is certified in Canada, add the translator's affidavit. You cannot translate your own documents.", translated),
  doc("Signed Use of a Representative form (IMM 5476)", "Only if someone is helping you with the application.", undefined, false),
  text("Anything else we should know?", "Previous refusals or sponsorships, or anything that is not clear.", undefined, false, "longtext"),
]);

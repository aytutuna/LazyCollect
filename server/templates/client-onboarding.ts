// New client onboarding. Checked 2026-11 against:
// - authorizing a representative online in My Account; form AUT-01 gives offline access only: canada.ca/en/revenue-agency/services/tax/representative-authorization/how.html
// - the SIN is given only where the law requires it, and a card is not an identity document: canada.ca/en/employment-social-development/services/sin/protection.html
// - photo ID: only what is needed to confirm identity, so the front of a license or the passport photo page
// - notice of assessment from CRA My Account: canada.ca/en/services/taxes/income-tax/personal-income-tax/after-you-file/noa-nor.html
import { ask, doc, template, text } from "./build";

const business = "Do you own a business or a corporation?";
const moved = "Has your name or address changed since your last return?";

export default template("client-onboarding", "New client onboarding", [
  doc("Photo ID", "Used only to confirm who you are. The front of your license or the passport photo page is enough."),
  doc("Confirmation of SIN letter", "Please do not send a photo of your SIN card. If you have the Service Canada letter you can send it. Otherwise leave this empty and we will arrange a safer way to get the number.", undefined, false),
  doc("Notice of assessment for the last tax year", "Sign in to CRA My Account and look under Tax returns, or use the copy that came in the mail.", undefined, true, "noa"),
  doc("Notice of assessment for the year before", "Same place as the last one.", undefined, true, "noa"),

  ask("Have you authorized us as your representative with the CRA?", "In CRA My Account choose Profile, then Add under Authorized representative. If we send you a request, you confirm it there. The paper form only gives us phone and mail access."),
  doc("Engagement letter, signed", "We send you the letter. Sign it, then add a photo or scan of the signed page."),

  ask(moved),
  text("Your new name or address", undefined, moved),

  ask(business),
  doc("Articles of incorporation or business registration", "And the business number if you have one.", business, false),
]);

// T1 personal tax organizer for the 2026 tax year. Checked 2026-11-25 against:
// - slip titles: canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/tax-slips.html
// - home office, detailed method only from 2023: canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/line-22900-other-employment-expenses/work-space-home-expenses.html
// - moving expenses, 40 km (line 21900): canada.ca/line-21900
// - child care receipts (line 21400): canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/line-21400-child-care-expenses/how-claim.html
// - FHSA, T4FHSA and Schedule 15: canada.ca/en/revenue-agency/services/tax/individuals/topics/first-home-savings-account/reporting-fhsa-activities-income-benefit-return.html
// - foreign property over $100,000, T1135: canada.ca/en/revenue-agency/services/tax/international-non-residents/information-been-moved/foreign-reporting/foreign-income-verification-statement.html
// - notice of assessment: canada.ca/en/services/taxes/income-tax/personal-income-tax/after-you-file/noa-nor.html
// - Quebec RL titles and the housing component of the solidarity credit: revenuquebec.ca/en/online-services/forms-and-publications/current-details/rl-1-t/ (rl-2-t to rl-31-t) and revenuquebec.ca/en/citizens/tax-credits/solidarity-tax-credit/
//   (Revenu Quebec refused automated fetches, so those titles come from its search listings)
// - employment expenses, home office costs an employee may claim: canada.ca/en/revenue-agency/services/forms-publications/publications/t4044/employment-expenses.html
// - RRSP 60-day window for 2026: contributions made from March 3, 2026 (the day after the 2025 deadline of March 2, 2026) to March 1, 2027 (day 60 after December 31, 2026, a Monday). The dates come from the 60-day rule; the CRA pages read on 2026-11-25 did not state them, so check them again in January
// - home office, employees: only the detailed method applies to 2023 and later, with Form T2200 kept on file (checked 2026-11-25, page dated 2026-01-20)
// - principal residence sales are reported on the return and designated on Schedule 3 and Form T2091
// - RL-6 is the Quebec Parental Insurance Plan slip; the slip for QPP benefits is not confirmed here, so the T4A(P) help only points to Retraite Québec
// - Home Buyers' Plan repayments: the HBP statement in CRA My Account
import type { Facts } from "../src/taxyear";
import { ask, doc, template, text } from "./build";

const feb = "Your payer sends this by the end of February.";
const marital = "Did your marital status change in {year}?";
const dependants = "Do you have dependants?";
const childcare = "Did you have childcare costs?";
const moved = "Did you move more than 40 km for work or school?";
const home = "Do you have a First Home Savings Account (FHSA), did you buy a first home, or are you repaying an RRSP Home Buyers' Plan?";
const sold = "Did you sell a home, other property or crypto in {year}?";
const selfEmployed = "Did you have self-employment income?";
const rental = "Did you earn rental income?";
const foreign = "Did you own foreign property costing more than C$100,000?";
const medical = "Did you have medical expenses?";
const donations = "Did you make charitable donations?";
const tuition = "Did you pay tuition?";
const wfh = "Did you work from home because your employer required it?";
const quebec = "Were you a resident of Quebec on December 31, {year}?";

// What changes from one tax year to the next, by year. Add the next year's entry when the CRA's pages for it are out (see the notes above).
export const facts: Facts = {
  2026: {
    rrsp_window: "March 3, 2026 to March 1, 2027",
    wfh_rule: "For 2026 only the detailed method is available. The flat rate ended after 2022.",
  },
};

export default template("t1-personal", "T1 personal tax organizer", [
  doc("Notice of assessment for {year-1}", "Sign in to CRA My Account and look under Tax returns, or use the copy that came in the mail.", undefined, true, "noa"),
  doc("T4 slips (employment income)", `${feb} Send one for each employer.`, undefined, false, "t4"),
  doc("T4A slips (pension, retirement, annuity and other income)", `${feb} This includes scholarships and some self-employment income.`, undefined, false),
  doc("T4A(P) slip (Canada Pension Plan benefits)", `${feb} Quebec residents: the pension slip from Retraite Québec.`, undefined, false),
  doc("T4A(OAS) slip (Old Age Security)", feb, undefined, false),
  doc("T4E slip (Employment Insurance benefits)", feb, undefined, false),
  doc("T5 slips (investment income)", `${feb} Banks and brokers send one for interest and dividends.`, undefined, false),
  doc("T3 slips (trust income)", "Usually sent by the end of March. Mutual funds and trusts send these.", undefined, false),
  doc("T5013 slips (partnership income)", "Usually sent by the end of March.", undefined, false),
  doc("T5008 slips (securities transactions)", "From your broker if you sold investments. Add a year-end statement if you have one.", undefined, false),
  doc("T4RSP and T4RIF slips (RRSP and RRIF income)", feb, undefined, false),
  doc("T5007 slips (social assistance and workers' compensation)", feb, undefined, false),
  doc("RRSP contribution receipts", "Contributions from {rrsp_window} can go on the {year} return. Your {year-1} notice of assessment shows your RRSP limit.", undefined, false),
  doc("Installment payment records", "The amounts you paid to the CRA and Revenu Québec in {year}.", undefined, false),

  ask(marital, "For example marriage, a new common-law partner, separation or a death."),
  text("What changed, and on what date?", "Add your new or former partner's name and their {year} net income if you know it.", marital),

  ask(dependants, "Children, or other family members you support."),
  text("Names and birth dates of your dependants", undefined, dependants, true, "longtext"),

  ask(childcare, "Daycare, a nanny, day camps or after-school care so you could work or study.", false),
  doc("Childcare receipts", "A receipt from each provider with the amount paid. If the provider is a person, the receipt must show their social insurance number.", childcare),

  ask(moved, "The new home must be at least 40 km closer to the new job or school."),
  text("Old and new addresses, and the date you moved", undefined, moved),
  doc("Moving expense receipts", "Movers, truck rental, travel, storage and temporary lodging.", moved),
  doc("Letter from your employer about moving costs", "Only if your employer paid or refunded part of the move.", moved, false),

  ask(home),
  doc("FHSA slip (T4FHSA) and account statements", "Your bank sends the T4FHSA by the end of February. Send one for each FHSA.", home, false),
  doc("Home Buyers' Plan details", "Only if you took money out of your RRSP for a first home. Your HBP statement in CRA My Account shows what you still have to repay.", home, false),
  doc("Home purchase closing documents", "The statement of adjustments or the closing letter from your lawyer.", home, false),

  ask(sold, "Real estate, shares, crypto or other property, including a home or cottage."),
  doc("Sale and cost details", "For each sale: the date, what you sold it for, what it cost you and any selling costs. If it was a home you lived in, tell us; the sale is still reported and the principal residence designation is made on your return.", sold),

  ask(selfEmployed, "Freelance work, gig work, a small business or commissions."),
  doc("Business income summary or invoices", "A sales report, or a list of invoices for the year.", selfEmployed),
  doc("Business expense receipts and bank statements", "Group receipts by type if you can: supplies, advertising, insurance, phone and so on. Keep your records for six years.", selfEmployed),
  doc("Vehicle log", "Business kilometres and total kilometres for the year.", selfEmployed, false),
  doc("GST/HST returns for the year", "Only if you are registered.", selfEmployed, false),

  ask(rental),
  doc("Rental income and expenses for each property", "Rent received, mortgage interest, property tax, insurance, repairs and utilities you paid.", rental),

  ask(foreign, "Property outside Canada, such as bank accounts, shares or real estate. A home you use personally does not count."),
  text("List of your foreign property", "For each one: what it is, the country, what it cost, the income it earned and any gain or loss.", foreign, true, "longtext"),
  doc("Foreign account or broker statements", undefined, foreign, false),

  ask(medical, "Costs you paid for yourself, a spouse or a dependant that insurance did not cover.", false),
  doc("Medical expense receipts", "Include insurance statements that show what was paid back to you.", medical),

  ask(donations, undefined, false),
  doc("Official donation receipts", "Receipts from registered charities. Checks and bank records are not enough.", donations),

  ask(tuition, "College, university or other post-secondary school.", false),
  doc("Tuition certificates (T2202)", "Your school usually posts it online in February. Send one for each school.", tuition),

  ask(wfh, "{wfh_rule}", false),
  doc("Form T2200 signed by your employer", "The Declaration of Conditions of Employment. Ask your employer or HR for it.", wfh),
  doc("Home expense records", "Rent if you rent, electricity, heat, water, minor maintenance and home internet, plus the size of your workspace compared with the whole home. Employees can't claim mortgage interest, property tax or home insurance (commission employees can claim some).", wfh, false),

  ask(quebec, "Quebec residents also file a Quebec return. Their slips come from the RL series."),
  doc("RL-1 slips (employment and other income)", feb, quebec),
  doc("RL-2 slips (retirement and annuity income)", feb, quebec, false),
  doc("RL-3 slips (investment income)", feb, quebec, false),
  doc("RL-5 slips (benefits and indemnities)", feb, quebec, false),
  doc("RL-6 slips (Quebec Parental Insurance Plan benefits)", feb, quebec, false),
  doc("RL-8 slips (post-secondary studies)", "Your school sends this along with the T2202.", quebec, false),
  doc("RL-24 slips (childcare expenses)", "Your childcare provider sends this.", quebec, false),
  doc("RL-31 slip (leased dwelling)", "Only if you rented your home. Your landlord gives you a copy by the end of February. It is needed for the solidarity tax credit.", quebec, false),
  doc("Other RL slips", "For example RL-10, RL-11, RL-15, RL-16 or RL-25.", quebec, false),
  doc("Quebec notice of assessment for {year-1}", undefined, quebec, false),

  text("Anything else we should know?", "Life changes, new income, or a question about your return.", undefined, false, "longtext"),
], facts);

import ircCitizenship from "./ircc-citizenship";
import ircExpressEntry from "./ircc-express-entry";
import ircPgwp from "./ircc-pgwp";
import ircSpousal from "./ircc-spousal-sponsorship";
import ircStudy from "./ircc-study-permit";
import ircVisitor from "./ircc-visitor-visa";
import ircWork from "./ircc-work-permit";
import ircWorkExtension from "./ircc-work-permit-extension";
import bookkeeping from "./bookkeeping-month-end";
import onboarding from "./client-onboarding";
import gstHst from "./gst-hst-return";
import t1Personal from "./t1-personal";
import t1SelfEmployed from "./t1-self-employed.json";
import t2YearEnd from "./t2-year-end";

// same order as builtinTemplates in src/templates.ts
export const builtinTemplatesFr = [
  t1Personal,
  t1SelfEmployed,
  t2YearEnd,
  bookkeeping,
  gstHst,
  onboarding,
  ircExpressEntry,
  ircSpousal,
  ircStudy,
  ircPgwp,
  ircWork,
  ircWorkExtension,
  ircVisitor,
  ircCitizenship,
];

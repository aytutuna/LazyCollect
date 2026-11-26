// French twin of ../ircc-visitor-visa.ts
import { ask, doc, template, text, tag } from "../build";

const invited = "Quelqu'un au Canada vous invite-t-il?";
const abroad = "Présentez-vous votre demande depuis un pays autre que celui qui a délivré votre passeport?";
const translated = "Certains de vos documents sont-ils rédigés dans une langue autre que le français ou l'anglais?";

export default template("ircc-visitor-visa", "Visa de visiteur", [
  tag(doc("Passeport", "La page avec votre photo et vos renseignements, et toutes les pages portant des visas ou des tampons. Il doit être valide au moins 6 mois après votre voyage.", undefined, true, "passport"), { per_person: "everyone", expiry: "expiry" }),
  tag(doc("Photo numérique", "Conforme aux spécifications d'IRCC pour les photos."), { per_person: "everyone" }),
  tag(doc("Preuve de fonds", "Relevés bancaires récents, habituellement des 6 derniers mois, avec les soldes et les coordonnées de la banque. Votre liste de contrôle d'IRCC peut demander une autre période.", undefined, true, "bank-statement"), { translation: true }),
  doc("Itinéraire de voyage", "Les dates, les lieux de séjour et le motif du voyage."),
  doc("Lettre d'emploi ou preuve d'inscription", "Sur papier à en-tête, datée de moins de 3 mois, signée par un gestionnaire ou les ressources humaines. Les étudiants envoient une lettre de leur établissement."),
  doc("Historique de voyages", "Visas et tampons des 10 dernières années.", undefined, false),
  ask(invited, "Un membre de la famille, un ami ou une entreprise."),
  doc("Lettre d'invitation", "Signée par l'hôte, avec son adresse et la façon dont vous vous connaissez.", invited),
  doc("Statut et adresse de l'hôte au Canada", "Une copie de son passeport, de sa carte de résident permanent, de son certificat de citoyenneté ou de son permis.", invited),
  doc("Preuve de votre lien avec votre hôte", "Un certificat de mariage ou de naissance, ou une déclaration d'union de fait (IMM 5409).", invited, false),
  ask(abroad, "IRCC demande une preuve de votre statut là où vous vivez."),
  doc("Preuve de statut là où vous vivez", "Votre permis ou votre visa pour ce pays.", abroad),
  tag(doc("Certificat de police", "De chaque pays où la personne a vécu 6 mois ou plus, seulement si IRCC en demande un.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  tag(doc("Reçu de l'examen médical", "Seulement si IRCC en demande un, par exemple pour un long séjour ou un séjour récent dans certains pays.", undefined, false), { per_person: "everyone", expiry: "issue", valid_months: 12 }),
  ask(translated),
  doc("Traductions certifiées", "Envoyez l'original et la traduction française ou anglaise. À moins que le traducteur ne soit agréé au Canada, ajoutez son affidavit.", translated),
  doc("Formulaire Recours aux services d'un représentant signé (IMM 5476)", "Seulement si quelqu'un vous aide avec la demande.", undefined, false),
  text("Y a-t-il autre chose que nous devrions savoir?", "Refus antérieurs, ou tout ce qui n'est pas clair.", undefined, false, "longtext"),
]);

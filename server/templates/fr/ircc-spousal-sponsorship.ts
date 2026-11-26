// French twin of ../ircc-spousal-sponsorship.ts
import { ask, doc, template, text, tag } from "../build";

const married = "Êtes-vous légalement marié à votre partenaire?";
const inCanada = "La personne parrainée vit-elle actuellement au Canada?";
const before = "L'un de vous deux a-t-il déjà été marié?";
const children = "Avez-vous des enfants à charge?";
const quebecSponsor = "Le répondant vit-il au Québec?";
const translated = "Certains de vos documents sont-ils rédigés dans une langue autre que le français ou l'anglais?";

export default template("ircc-spousal-sponsorship", "Parrainage d'un époux ou conjoint", [
  tag(doc("Passeport", "La page avec la photo et les renseignements, et toutes les pages portant des visas ou des tampons. Un fichier par personne.", undefined, true, "passport"), { per_person: "everyone", expiry: "expiry" }),
  doc("Formulaires de parrainage signés (IMM 1344 et IMM 5532)", "Votre représentant vous les remet pour signature. Vous signez tous les deux la demande de parrainage."),
  doc("Carte de résident permanent ou certificat de citoyenneté du répondant", "Recto et verso, ou le certificat."),
  ask(married, "Répondez non si vous vivez ensemble comme conjoints de fait."),
  doc("Certificat de mariage", "Il doit montrer que le mariage a été enregistré. Un acte de célébration ou une licence de mariage seuls ne sont pas acceptés.", married),
  doc("Déclaration d'union de fait (IMM 5409)", "Signée par vous deux.", [married, "no"]),
  doc("Preuve que vous vivez ensemble depuis 12 mois ou plus", "Bail conjoint, factures ou lettres adressés à vous deux à la même adresse.", [married, "no"]),
  doc("Photos de vous deux au fil du temps", "Quelques-unes de différentes années et de différents endroits, avec les dates si vous les connaissez."),
  doc("Conversations, appels et messages", "Une sélection qui montre des contacts réguliers au fil du temps. Vous n'avez pas à tout envoyer.", undefined, false),
  doc("Historique de voyages ensemble", "Billets, cartes d'embarquement ou tampons de voyages faits ensemble.", undefined, false),
  doc("Comptes bancaires conjoints, baux ou factures", "Tout ce qui montre des finances communes ou un domicile commun.", undefined, false),
  doc("Documents sur le revenu du répondant", "IRCC n'exige aucun revenu minimal pour parrainer un époux ou un conjoint; n'envoyez ces documents que si votre représentant les demande.", undefined, false),
  ask(inCanada, "Si votre partenaire est au Canada, IRCC vérifie son statut temporaire."),
  doc("Preuve du statut du demandeur au Canada", "Son permis, sa fiche de visiteur ou un autre document, et tout reçu de demande de prolongation.", inCanada),
  ask(before),
  doc("Certificat de divorce ou de décès", "Pour chaque mariage ou union de fait antérieur, pour l'un ou l'autre de vous.", before),
  ask(quebecSponsor, "Le Québec a son propre engagement de parrainage pour les répondants qui y vivent.", false),
  doc("Engagement de parrainage du Québec (suivez les instructions d'IRCC et du Québec)", "Le ministère de l'Immigration du Québec vous remet l'engagement à signer. Envoyez la copie signée dès que vous l'avez.", quebecSponsor, false),
  ask(children),
  doc("Certificats de naissance et pièces d'identité des enfants", "Certificats de naissance indiquant les parents, et un passeport ou une pièce d'identité pour chaque enfant.", children),
  tag(doc("Certificats de police", "Pour la personne parrainée et tout membre adulte de la famille qui n'est pas citoyen ni résident permanent; pas pour le répondant. De chaque pays où elle a vécu 6 mois consécutifs ou plus depuis ses 18 ans. Obtenez le certificat après avoir quitté ce pays, ou dans le délai qu'IRCC accorde.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  tag(doc("Reçu de l'examen médical", "Pour la personne parrainée et tout membre adulte de la famille qui n'est pas citoyen ni résident permanent; pas pour le répondant. Quand IRCC vous le demande, prenez rendez-vous avec un médecin désigné. Chaque personne parrainée doit passer un examen, y compris les enfants.", undefined, false), { per_person: "everyone", expiry: "issue", valid_months: 12 }),
  tag(doc("Photos numériques", "Conformes aux spécifications d'IRCC pour les photos.", undefined, false), { per_person: "everyone" }),
  doc("Reçu du paiement des frais", "Le reçu du paiement en ligne."),
  ask(translated),
  doc("Traductions certifiées", "Envoyez l'original et la traduction française ou anglaise. À moins que le traducteur ne soit agréé au Canada, ajoutez son affidavit. Vous ne pouvez pas traduire vos propres documents.", translated),
  doc("Formulaire Recours aux services d'un représentant signé (IMM 5476)", "Seulement si quelqu'un vous aide avec la demande.", undefined, false),
  text("Y a-t-il autre chose que nous devrions savoir?", "Refus ou parrainages antérieurs, ou tout ce qui n'est pas clair.", undefined, false, "longtext"),
]);

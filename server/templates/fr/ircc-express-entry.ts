// French twin of ../ircc-express-entry.ts
import { ask, doc, template, text, tag } from "../build";

const education = "Avez-vous obtenu votre diplôme le plus élevé à l'extérieur du Canada?";
const exempt = "Êtes-vous dispensé de présenter une preuve de fonds (Catégorie de l'expérience canadienne, ou travail au Canada avec une offre d'emploi valide)?";
const offer = "Avez-vous une offre d'emploi d'un employeur canadien?";
const nominated = "Une province ou un territoire vous a-t-il désigné?";
const partner = "Avez-vous un époux ou un conjoint de fait?";
const children = "Avez-vous des enfants à charge?";
const translated = "Certains de vos documents sont-ils rédigés dans une langue autre que le français ou l'anglais?";

export default template("ircc-express-entry", "Entrée express : résidence permanente après une invitation", [
  doc("Invitation à présenter une demande et numéro de profil", "Dans votre compte Entrée express. L'invitation est valide pendant 60 jours."),
  tag(doc("Passeport", "La page avec votre photo et vos renseignements, et toutes les pages portant des visas ou des tampons. S'il expire dans moins de 6 mois, renouvelez-le d'abord.", undefined, true, "passport"), { per_person: "everyone", expiry: "expiry" }),
  doc("Résultats du test de langue", "Les résultats utilisés pour votre profil, d'un test approuvé comme IELTS, CELPIP, TEF ou TCF."),
  ask(education),
  doc("Évaluation des diplômes d'études (EDE)", "Le rapport d'un organisme désigné.", education),
  tag(doc("Diplômes, certificats et relevés de notes", "Pour les études pour lesquelles vous avez demandé des points."), { translation: true }),
  doc("Lettres de référence de travail", "Sur papier à en-tête de l'entreprise, avec votre titre de poste, vos fonctions, vos heures par semaine, votre salaire, les dates, ainsi que le nom et les coordonnées de votre superviseur."),
  ask(exempt, "Si vous êtes dispensé, vous n'envoyez pas de preuve de fonds."),
  doc("Lettre expliquant votre dispense (Catégorie de l'expérience canadienne, ou autorisé à travailler au Canada avec une offre d'emploi valide)", "Indiquez quelle dispense s'applique et joignez ce qui la démontre, comme votre permis de travail et votre offre d'emploi.", [exempt, "yes"]),
  doc("Preuve de fonds", "Une lettre de chaque banque sur papier à en-tête avec ses coordonnées, votre nom et, pour chaque compte, le numéro, la date d'ouverture, le solde actuel et le solde moyen des 6 derniers mois. Le minimum dépend de la taille de votre famille, y compris les membres de la famille qui ne vous accompagneront pas. Pour une personne, IRCC indique 15 263 $ CA (mis à jour le 7 juillet 2025); consultez le tableau à jour.", [exempt, "no"], true, "bank-statement"),
  ask(offer),
  doc("Offre d'emploi", "La lettre d'offre signée, si vous avez demandé des points pour elle ou si vous l'utilisez pour être dispensé de la preuve de fonds.", offer, false),
  ask(nominated),
  doc("Désignation provinciale", "Le certificat de désignation.", nominated),
  tag(doc("Certificats de police", "Pour chaque pays où la personne a vécu 6 mois consécutifs ou plus au cours des 10 dernières années, après ses 18 ans. Du pays où elle vit actuellement : délivré au plus 6 mois avant votre demande. D'un pays qu'elle a quitté : délivré après son dernier séjour dans ce pays. Un agent peut en demander d'autres.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  tag(doc("Reçu de l'examen médical", "Prenez un seul rendez-vous avec un médecin désigné et envoyez la feuille de renseignements d'eMédical. Les membres de la famille doivent aussi passer un examen, même s'ils ne vous accompagneront pas. Votre lettre de résultats médicaux indique sa date d'expiration. Il doit encore être valide à votre entrée au Canada."), { per_person: "everyone", expiry: "issue", valid_months: 12 }),
  ask(partner),
  doc("Documents de l'époux ou du conjoint", "Passeport, certificat de mariage ou déclaration d'union de fait (IMM 5409), ainsi que les certificats de police et les documents de langue ou d'études que votre liste de contrôle demande.", partner),
  ask(children),
  doc("Certificats de naissance des enfants", "Indiquant les deux parents. Ajoutez les passeports si votre liste de contrôle les demande.", children),
  doc("Formulaire de renseignements sur la famille", "Le formulaire IMM 5406 et les formulaires de renseignements généraux se remplissent dans votre compte IRCC. Envoyez ici tout ce que votre représentant vous demande.", undefined, false),
  tag(doc("Photos numériques", "Seulement si votre liste de contrôle d'IRCC les demande.", undefined, false), { per_person: "everyone" }),
  ask(translated),
  doc("Traductions certifiées", "Envoyez une numérisation de l'original et la traduction française ou anglaise certifiée.", translated),
  doc("Formulaire Recours aux services d'un représentant signé (IMM 5476)", "Seulement si quelqu'un vous aide avec la demande.", undefined, false),
  text("Y a-t-il autre chose que nous devrions savoir?", "Changements de nom, périodes sans emploi ou tout ce qui n'est pas clair.", undefined, false, "longtext"),
]);

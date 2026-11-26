// French twin of ../ircc-citizenship.ts
import { ask, doc, template, text, tag } from "../build";

const adult = "Avez-vous entre 18 et 54 ans?";
const renamed = "Votre nom ou votre date de naissance a-t-il changé depuis l'émission de votre carte de résident permanent?";
const translated = "Certains de vos documents sont-ils rédigés dans une langue autre que le français ou l'anglais?";

export default template("ircc-citizenship", "Demande de citoyenneté (adulte)", [
  doc("Carte de résident permanent", "Recto et verso dans un seul fichier. Si vous n'avez pas de carte ou si elle n'est pas valide, indiquez-le dans les notes."),
  tag(doc("Pages de passeport", "Copies en couleur de vos passeports et documents de voyage pour toute la période que vous comptez, afin qu'IRCC puisse vérifier vos jours au Canada.", undefined, true, "passport"), { per_person: "everyone" }),
  doc("Calcul de la présence effective", "Depuis votre compte IRCC ou la calculatrice d'IRCC : vous devez avoir au moins 1 095 jours au Canada dans les 5 années précédant votre demande."),
  ask(adult, "Une preuve de connaissance de la langue est exigée entre ces âges."),
  doc("Preuve de connaissance de la langue", "Un diplôme ou un relevé de notes en français ou en anglais, un résultat de test accepté (CELPIP-G, CELPIP-LS, IELTS Général, PTE Core, TEF, TCF), ou un certificat du programme CLIC ou LINC.", adult),
  doc("Pièces d'identité émises par le gouvernement", "Deux pièces d'identité indiquant votre nom et votre date de naissance. Au moins une doit comporter votre photo."),
  tag(doc("Photos numériques", "Conformes aux spécifications d'IRCC pour les photos. Une demande papier exige deux photos imprimées identiques."), { per_person: "everyone" }),
  tag(doc("Certificats de police", "De chaque pays à l'extérieur du Canada où la personne a vécu 183 jours consécutifs ou plus au cours des 4 dernières années, après ses 18 ans. Délivrés après la dernière fois où elle était dans ce pays, ou au plus 6 mois avant la signature de la demande.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  ask(renamed),
  doc("Preuve du changement de nom", "Certificat de mariage, ordonnance d'un tribunal ou document officiel qui a modifié le nom.", renamed),
  doc("Avis de cotisation", "IRCC vérifie les déclarations de revenus auprès de l'ARC. N'envoyez ces documents que si votre représentant les demande.", undefined, false, "noa"),
  doc("Reçu du paiement des frais", "Le reçu du paiement en ligne."),
  ask(translated),
  doc("Traductions certifiées", "Envoyez l'original et la traduction française ou anglaise, faite par un traducteur membre d'un ordre ou d'une association de traducteurs du Canada, ou accompagnée de l'affidavit du traducteur.", translated),
  doc("Formulaire Recours aux services d'un représentant signé (IMM 5476)", "Seulement si quelqu'un vous aide avec la demande.", undefined, false),
  text("Y a-t-il autre chose que nous devrions savoir?", "Longs voyages, périodes passées à l'extérieur du Canada ou tout ce qui n'est pas clair.", undefined, false, "longtext"),
]);

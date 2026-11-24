// French twin of ../ircc-pgwp.ts
import { ask, doc, template, text, tag } from "../build";

const newRules = "Présentez-vous votre demande de permis de travail postdiplôme (PTPD) le 1er novembre 2024 ou après?";
const newPermit = "Avez-vous présenté votre demande de permis d'études le 1er novembre 2024 ou après?";
const expired = "Votre permis d'études est-il déjà expiré?";
const translated = "Certains de vos documents sont-ils rédigés dans une langue autre que le français ou l'anglais?";

export default template("ircc-pgwp", "Permis de travail postdiplôme (PTPD)", [
  tag(doc("Passeport", "La page avec votre photo et vos renseignements, et toutes les pages portant des visas ou des tampons. Un fichier.", undefined, true, "passport"), { per_person: "everyone", expiry: "expiry" }),
  doc("Permis d'études", "Votre permis actuel, et les précédents si vous en avez eu plus d'un."),
  doc("Relevé de notes officiel", "De votre établissement, montrant l'ensemble du programme."),
  doc("Lettre ou certificat attestant que vous avez terminé votre programme", "La lettre de l'établissement, ou votre diplôme ou certificat une fois que vous l'avez. Présentez votre demande dans les 180 jours suivant la confirmation par l'établissement que vous avez terminé."),
  ask(newRules, "L'exigence de langue dépend de la date de votre demande de PTPD."),
  doc("Résultats du test de langue", "Niveau 7 dans les quatre compétences pour un programme universitaire, niveau 5 pour un programme collégial ou autre programme non universitaire. Les diplômés d'écoles de pilotage sont dispensés.", newRules),
  ask(newPermit, "L'exigence liée au domaine d'études dépend de la date de votre demande de permis d'études."),
  doc("Preuve que votre programme appartient à un domaine d'études admissible", "Seulement si votre programme n'est pas un baccalauréat, une maîtrise ou un doctorat. IRCC a une liste des domaines d'études admissibles.", newPermit, false),
  ask(expired, "S'il est expiré, vous pouvez demander le rétablissement de votre statut dans les 90 jours."),
  doc("Lettre expliquant l'expiration du permis", "La date d'expiration, et la raison du retard de la demande.", expired),
  tag(doc("Photo numérique", "Seulement si votre liste de contrôle d'IRCC en demande une.", undefined, false), { per_person: "everyone" }),
  tag(doc("Certificat de police", "De chaque pays où la personne a vécu 6 mois ou plus, seulement si IRCC en demande un.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  tag(doc("Reçu de l'examen médical", "Seulement si IRCC en demande un.", undefined, false), { per_person: "everyone", expiry: "issue", valid_months: 12 }),
  ask(translated),
  doc("Traductions certifiées", "Envoyez l'original et la traduction française ou anglaise. À moins que le traducteur ne soit agréé au Canada, ajoutez son affidavit.", translated),
  doc("Formulaire Recours aux services d'un représentant signé (IMM 5476)", "Seulement si quelqu'un vous aide avec la demande.", undefined, false),
  text("Y a-t-il autre chose que nous devrions savoir?", "Un congé d'études, un changement de programme ou tout ce qui n'est pas clair.", undefined, false, "longtext"),
]);

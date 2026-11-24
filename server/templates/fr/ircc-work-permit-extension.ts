// French twin of ../ircc-work-permit-extension.ts
import { ask, doc, template, text, tag } from "../build";

const lmia = "L'offre d'emploi est-elle fondée sur une EIMT positive?";
const quebec = "L'emploi sera-t-il au Québec et durera-t-il plus de 30 jours?";
const expired = "Votre permis de travail est-il déjà expiré?";
const family = "Votre époux, conjoint ou vos enfants présentent-ils une demande avec vous?";
const translated = "Certains de vos documents sont-ils rédigés dans une langue autre que le français ou l'anglais?";

export default template("ircc-work-permit-extension", "Prolongation de permis de travail, depuis l'intérieur du Canada", [
  tag(doc("Passeport", "La page avec votre photo et vos renseignements, les pages avec votre tampon d'entrée le plus récent, et tout visa. Un fichier.", undefined, true, "passport"), { per_person: "everyone", expiry: "expiry" }),
  doc("Permis de travail actuel", "Et les permis précédents, s'il y en a. IRCC veut voir votre statut."),
  ask(expired, "S'il est expiré, vous pouvez demander le rétablissement de votre statut dans les 90 jours. La prochaine fois, présentez votre demande au moins 30 jours avant la date d'expiration."),
  doc("Lettre expliquant l'expiration du permis", "La date d'expiration, et la raison du retard de la demande.", expired),
  ask(lmia, "Un emploi qui exige une étude d'impact sur le marché du travail (EIMT) a une EIMT positive de l'employeur."),
  doc("EIMT positive", "Une copie de la lettre de décision sur l'EIMT de l'employeur.", lmia),
  text("Numéro de l'EIMT", "Le numéro de dossier imprimé sur l'EIMT.", lmia),
  text("Numéro de l'offre d'emploi", "L'employeur paie des frais et obtient un numéro : la lettre A suivie de 7 chiffres. Il ne peut servir qu'une seule fois.", [lmia, "no"]),
  doc("Lettre d'offre d'emploi", "Signée par l'employeur, avec le titre du poste, les fonctions, le salaire et la date de début."),
  doc("Contrat de travail", "Signé par vous et par l'employeur."),
  doc("Curriculum vitæ", "À jour, avec les dates et les employeurs."),
  doc("Preuve d'expérience de travail", "Bulletins de paie récents et lettres de référence de vos employeurs canadiens."),
  doc("Documents d'études", "Diplômes, certificats, permis ou formations exigés pour l'emploi. Si rien ne s'applique, envoyez une page indiquant Sans objet."),
  ask(quebec),
  doc("Certificat d'acceptation du Québec (CAQ)", "Délivré par le ministère de l'Immigration du Québec. L'employeur le demande habituellement.", quebec),
  tag(doc("Photo numérique", "Conforme aux spécifications d'IRCC pour les photos.", undefined, false), { per_person: "everyone" }),
  ask(family),
  doc("Passeports et documents d'état civil des membres de la famille", "Passeport, permis actuel, certificat de mariage ou déclaration d'union de fait (IMM 5409) et certificats de naissance pour chaque personne.", family),
  tag(doc("Certificat de police", "De chaque pays où la personne a vécu 6 mois ou plus, seulement si IRCC en demande un.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  tag(doc("Reçu de l'examen médical", "Seulement si IRCC en demande un.", undefined, false), { per_person: "everyone", expiry: "issue", valid_months: 12 }),
  ask(translated),
  doc("Traductions certifiées", "Envoyez l'original et la traduction française ou anglaise. À moins que le traducteur ne soit agréé au Canada, ajoutez son affidavit.", translated),
  doc("Formulaire Recours aux services d'un représentant signé (IMM 5476)", "Seulement si quelqu'un vous aide avec la demande.", undefined, false),
  text("Y a-t-il autre chose que nous devrions savoir?", "Périodes sans emploi, changements d'employeur ou tout ce qui n'est pas clair.", undefined, false, "longtext"),
]);

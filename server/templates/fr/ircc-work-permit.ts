// French twin of ../ircc-work-permit.ts
import { ask, doc, template, text, tag } from "../build";

const lmia = "L'offre d'emploi est-elle fondée sur une EIMT positive?";
const quebec = "L'emploi sera-t-il au Québec et durera-t-il plus de 30 jours?";
const family = "Votre époux, conjoint ou vos enfants présenteront-ils une demande avec vous?";
const abroad = "Présentez-vous votre demande depuis un pays autre que celui qui a délivré votre passeport?";
const translated = "Certains de vos documents sont-ils rédigés dans une langue autre que le français ou l'anglais?";

export default template("ircc-work-permit", "Permis de travail propre à un employeur, depuis l'extérieur du Canada", [
  tag(doc("Passeport", "La page avec votre photo et vos renseignements, et toutes les pages portant des visas ou des tampons. Un fichier.", undefined, true, "passport"), { per_person: "everyone", expiry: "expiry" }),
  ask(lmia, "Un emploi qui exige une étude d'impact sur le marché du travail (EIMT) a une EIMT positive de l'employeur."),
  doc("EIMT positive", "Une copie de la lettre de décision sur l'EIMT de l'employeur.", lmia),
  text("Numéro de l'EIMT", "Le numéro de dossier imprimé sur l'EIMT.", lmia),
  text("Numéro de l'offre d'emploi", "L'employeur paie des frais et obtient un numéro : la lettre A suivie de 7 chiffres. Il ne peut servir qu'une seule fois.", [lmia, "no"]),
  doc("Lettre d'offre d'emploi", "Signée par l'employeur, avec le titre du poste, les fonctions, le salaire et la date de début."),
  doc("Contrat de travail", "Signé par vous et par l'employeur."),
  doc("Curriculum vitæ", "À jour, avec les dates et les employeurs."),
  doc("Preuve d'expérience de travail", "Lettres de référence d'anciens employeurs et bulletins de paie."),
  doc("Documents d'études", "Diplômes, certificats, permis ou formations exigés pour l'emploi. Si rien ne s'applique, envoyez une page indiquant Sans objet."),
  ask(quebec),
  doc("Certificat d'acceptation du Québec (CAQ)", "Délivré par le ministère de l'Immigration du Québec. L'employeur le demande habituellement.", quebec),
  tag(doc("Photo numérique", "Conforme aux spécifications d'IRCC pour les photos.", undefined, false), { per_person: "everyone" }),
  ask(abroad, "IRCC demande une preuve de votre statut là où vous vivez."),
  doc("Preuve de statut là où vous vivez", "Votre permis ou votre visa pour ce pays.", abroad),
  ask(family),
  doc("Passeports et documents d'état civil des membres de la famille", "Passeport, certificat de mariage ou déclaration d'union de fait (IMM 5409) et certificats de naissance pour chaque personne.", family),
  tag(doc("Certificat de police", "De chaque pays où la personne a vécu 6 mois ou plus, seulement si IRCC en demande un.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  tag(doc("Reçu de l'examen médical", "Nécessaire pour certains emplois et certains pays. Prenez rendez-vous avec un médecin désigné quand IRCC vous le demande.", undefined, false), { per_person: "everyone", expiry: "issue", valid_months: 12 }),
  ask(translated),
  doc("Traductions certifiées", "Envoyez l'original et la traduction française ou anglaise. À moins que le traducteur ne soit agréé au Canada, ajoutez son affidavit.", translated),
  doc("Formulaire Recours aux services d'un représentant signé (IMM 5476)", "Seulement si quelqu'un vous aide avec la demande.", undefined, false),
  text("Y a-t-il autre chose que nous devrions savoir?", "Refus ou permis antérieurs, ou tout ce qui n'est pas clair.", undefined, false, "longtext"),
]);

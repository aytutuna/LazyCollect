// French twin of ../ircc-study-permit.ts
import { ask, doc, template, text, tag } from "../build";

const quebec = "Étudierez-vous au Québec?";
const pal = "Votre établissement ou votre province vous a-t-il remis une lettre d'attestation provinciale ou territoriale (LAP ou LAT)?";
const minor = "Êtes-vous mineur là où vous étudierez (moins que l'âge de la majorité à cet endroit)?";
const family = "Votre époux, conjoint ou vos enfants vous accompagneront-ils ou présenteront-ils une demande avec vous?";
const abroad = "Présentez-vous votre demande depuis un pays autre que celui qui a délivré votre passeport?";
const translated = "Certains de vos documents sont-ils rédigés dans une langue autre que le français ou l'anglais?";

export default template("ircc-study-permit", "Permis d'études, demande depuis l'extérieur du Canada", [
  tag(doc("Passeport", "La page avec votre photo et vos renseignements, et toutes les pages portant des visas ou des tampons. Un fichier.", undefined, true, "passport"), { per_person: "everyone", expiry: "expiry" }),
  doc("Lettre d'acceptation", "De votre établissement d'enseignement désigné (EED). Un établissement postsecondaire doit la confirmer auprès d'IRCC."),
  ask(quebec, "Le Québec a son propre certificat d'acceptation au lieu de la lettre d'attestation."),
  doc("Certificat d'acceptation du Québec (CAQ)", "Délivré par le ministère de l'Immigration du Québec.", quebec),
  ask(pal, "La plupart des demandeurs en ont besoin d'une, délivrée pour l'année en cours. Les demandeurs au Québec ont plutôt besoin du CAQ."),
  doc("Lettre d'attestation provinciale (LAP ou LAT)", "Elle doit être valide le jour où vous présentez votre demande.", pal),
  doc("Preuve que vous n'avez pas besoin d'une LAP", "Vous n'avez habituellement pas besoin d'une LAP ou d'une LAT si vous étudiez au préscolaire, au primaire ou au secondaire, dans un programme de maîtrise ou de doctorat d'un établissement public commençant le 1er janvier 2026 ou après, dans le cadre du Projet pilote pour étudiants des communautés francophones en situation minoritaire, dans un collège militaire désigné par le gouvernement fédéral, ou avec une bourse d'Affaires mondiales Canada, entre autres cas. Envoyez la preuve de votre dispense.", [pal, "no"], false),
  tag(doc("Preuve de fonds", "Frais de subsistance à l'extérieur du Québec pour les demandes présentées à partir du 1er septembre 2026 : 23 448 $ CA pour une personne, 29 192 $ CA pour deux, 35 888 $ CA pour trois, 43 572 $ CA pour quatre, plus les frais de scolarité et de voyage. Le Québec fixe ses propres montants. Relevés bancaires des 6 derniers mois, un CPG canadien ou une lettre de bourse. Expliquez tout dépôt important.", undefined, true, "bank-statement"), { translation: true }),
  doc("Lettre explicative ou plan d'études", "IRCC en recommande une : pourquoi ce programme, pourquoi le Canada, et ce que vous ferez ensuite.", undefined, false),
  tag(doc("Diplômes et relevés de notes antérieurs", "Ils montrent que vous répondez aux conditions d'admission du programme."), { translation: true }),
  tag(doc("Photo numérique", "Seulement si votre liste de contrôle d'IRCC en demande une. Les personnes qui donnent leurs données biométriques n'envoient habituellement pas de photos papier.", undefined, false), { per_person: "everyone" }),
  ask(abroad, "IRCC demande une preuve de votre statut là où vous vivez."),
  doc("Preuve de statut là où vous vivez", "Votre permis ou votre visa pour ce pays.", abroad),
  ask(minor, "L'âge dépend de la province."),
  doc("Déclaration de tutelle", "Formulaire IMM 5646, signé par le tuteur au Canada et par les parents.", minor),
  doc("Passeport ou statut du tuteur au Canada", "Une copie du passeport, de la carte de résident permanent ou du certificat de citoyenneté du tuteur.", minor),
  ask(family),
  doc("Passeports et documents d'état civil des membres de la famille", "Passeport, certificat de mariage ou déclaration d'union de fait (IMM 5409) et certificats de naissance pour chaque personne.", family),
  tag(doc("Certificat de police", "De chaque pays où la personne a vécu 6 mois ou plus, seulement si IRCC en demande un.", undefined, false), { per_person: "adults", expiry: "issue", valid_months: 6, translation: true }),
  tag(doc("Reçu de l'examen médical", "Nécessaire dans certains cas, par exemple si vous resterez plus de 6 mois et avez vécu dans un pays désigné pendant 6 mois ou plus au cours de la dernière année, ou si vous travaillerez auprès d'enfants, dans le domaine de la santé ou en agriculture. Attendez les instructions d'IRCC.", undefined, false), { per_person: "everyone", expiry: "issue", valid_months: 12 }),
  ask(translated),
  doc("Traductions certifiées", "Envoyez l'original et la traduction française ou anglaise. À moins que le traducteur ne soit agréé au Canada, ajoutez son affidavit. Vous et votre famille ne pouvez pas traduire vos propres documents.", translated),
  doc("Formulaire Recours aux services d'un représentant signé (IMM 5476)", "Seulement si quelqu'un vous aide avec la demande.", undefined, false),
  text("Y a-t-il autre chose que nous devrions savoir?", "Refus, permis antérieurs ou tout ce qui n'est pas clair.", undefined, false, "longtext"),
]);

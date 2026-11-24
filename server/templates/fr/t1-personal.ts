// French twin of ../t1-personal.ts
import { ask, doc, template, text } from "../build";

const feb = "Votre payeur vous l'envoie d'ici la fin de février.";
const marital = "Votre état civil a-t-il changé en 2025?";
const dependants = "Avez-vous des personnes à charge?";
const childcare = "Avez-vous eu des frais de garde d'enfants?";
const moved = "Avez-vous déménagé de plus de 40 km pour le travail ou les études?";
const home = "Avez-vous un compte d'épargne libre d'impôt pour l'achat d'une première propriété (CELIAPP), avez-vous acheté une première propriété, ou remboursez-vous un Régime d'accession à la propriété (RAP) de votre REER?";
const sold = "Avez-vous vendu une maison, un autre bien ou des cryptomonnaies en 2025?";
const selfEmployed = "Avez-vous eu des revenus de travail autonome?";
const rental = "Avez-vous gagné des revenus de location?";
const foreign = "Déteniez-vous des biens étrangers ayant coûté plus de 100 000 $ CA?";
const medical = "Avez-vous eu des frais médicaux?";
const donations = "Avez-vous fait des dons de bienfaisance?";
const tuition = "Avez-vous payé des frais de scolarité?";
const wfh = "Avez-vous travaillé à domicile parce que votre employeur l'exigeait?";
const quebec = "Étiez-vous résident du Québec le 31 décembre 2025?";

export default template("t1-personal", "Aide-mémoire T1 pour particuliers, 2025", [
  doc("Avis de cotisation de 2024", "Ouvrez une session dans Mon dossier de l'ARC et allez à Déclarations de revenus, ou utilisez la copie reçue par la poste.", undefined, true, "noa"),
  doc("Feuillets T4 (revenus d'emploi)", `${feb} Envoyez-en un pour chaque employeur.`, undefined, false, "t4"),
  doc("Feuillets T4A (pension, retraite, rente et autres revenus)", `${feb} Cela comprend les bourses d'études et certains revenus de travail autonome.`, undefined, false),
  doc("Feuillet T4A(P) (prestations du Régime de pensions du Canada)", `${feb} Résidents du Québec : le feuillet de pension de Retraite Québec.`, undefined, false),
  doc("Feuillet T4A(OAS) (Sécurité de la vieillesse)", feb, undefined, false),
  doc("Feuillet T4E (prestations d'assurance-emploi)", feb, undefined, false),
  doc("Feuillets T5 (revenus de placement)", `${feb} Les banques et les courtiers en envoient un pour les intérêts et les dividendes.`, undefined, false),
  doc("Feuillets T3 (revenus de fiducie)", "Habituellement envoyés d'ici la fin de mars. Les fonds communs de placement et les fiducies les envoient.", undefined, false),
  doc("Feuillets T5013 (revenus de société de personnes)", "Habituellement envoyés d'ici la fin de mars.", undefined, false),
  doc("Feuillets T5008 (opérations sur titres)", "De votre courtier si vous avez vendu des placements. Ajoutez un relevé de fin d'année si vous en avez un.", undefined, false),
  doc("Feuillets T4RSP et T4RIF (revenus de REER et de FERR)", feb, undefined, false),
  doc("Feuillets T5007 (aide sociale et indemnités pour accident du travail)", feb, undefined, false),
  doc("Reçus de cotisations au REER", "Les cotisations versées du 3 mars 2025 au 2 mars 2026 peuvent figurer dans la déclaration de 2025. Votre avis de cotisation de 2024 indique votre plafond de REER.", undefined, false),
  doc("Relevés des acomptes provisionnels", "Les montants que vous avez versés à l'ARC et à Revenu Québec en 2025.", undefined, false),

  ask(marital, "Par exemple un mariage, un nouveau conjoint de fait, une séparation ou un décès."),
  text("Qu'est-ce qui a changé, et à quelle date?", "Ajoutez le nom de votre nouveau conjoint ou de votre ex-conjoint et son revenu net de 2025 si vous le connaissez.", marital),

  ask(dependants, "Enfants, ou autres membres de la famille que vous soutenez."),
  text("Noms et dates de naissance de vos personnes à charge", undefined, dependants, true, "longtext"),

  ask(childcare, "Garderie, nounou, camps de jour ou service de garde après l'école pour vous permettre de travailler ou d'étudier.", false),
  doc("Reçus de frais de garde", "Un reçu de chaque fournisseur indiquant le montant payé. Si le fournisseur est un particulier, le reçu doit indiquer son numéro d'assurance sociale.", childcare),

  ask(moved, "Votre nouveau domicile doit être au moins 40 km plus près du nouveau travail ou de la nouvelle école."),
  text("Anciennes et nouvelles adresses, et date du déménagement", undefined, moved),
  doc("Reçus des frais de déménagement", "Déménageurs, location de camion, déplacement, entreposage et hébergement temporaire.", moved),
  doc("Lettre de votre employeur sur les frais de déménagement", "Seulement si votre employeur a payé ou remboursé une partie du déménagement.", moved, false),

  ask(home),
  doc("Feuillet du CELIAPP (T4FHSA) et relevés de compte", "Votre banque envoie le T4FHSA d'ici la fin de février. Envoyez-en un pour chaque CELIAPP.", home, false),
  doc("Détails du Régime d'accession à la propriété (RAP)", "Seulement si vous avez retiré de l'argent de votre REER pour une première propriété. Votre relevé du RAP dans Mon dossier de l'ARC indique ce qu'il vous reste à rembourser.", home, false),
  doc("Documents de clôture de l'achat de la propriété", "L'état des rajustements ou la lettre de clôture de votre notaire ou avocat.", home, false),

  ask(sold, "Immeubles, actions, cryptomonnaies ou autres biens, y compris une maison ou un chalet."),
  doc("Détails de la vente et du coût", "Pour chaque vente : la date, le prix de vente, ce que le bien vous a coûté et les frais de vente. S'il s'agissait d'une maison où vous habitiez, dites-le-nous; la vente doit tout de même être déclarée et la désignation de résidence principale se fait dans votre déclaration.", sold),

  ask(selfEmployed, "Travail à la pige, travail à la demande, petite entreprise ou commissions."),
  doc("Sommaire des revenus d'entreprise ou factures", "Un rapport de ventes, ou une liste des factures de l'année.", selfEmployed),
  doc("Reçus de dépenses d'entreprise et relevés bancaires", "Regroupez les reçus par type si possible : fournitures, publicité, assurance, téléphone, etc. Conservez vos registres pendant six ans.", selfEmployed),
  doc("Registre des déplacements", "Kilomètres d'affaires et total des kilomètres pour l'année.", selfEmployed, false),
  doc("Déclarations de TPS/TVH de l'année", "Seulement si vous êtes inscrit.", selfEmployed, false),

  ask(rental),
  doc("Revenus et dépenses de location pour chaque immeuble", "Loyers reçus, intérêts hypothécaires, taxes foncières, assurance, réparations et services publics que vous avez payés.", rental),

  ask(foreign, "Biens situés à l'extérieur du Canada, comme des comptes bancaires, des actions ou des immeubles. Une maison que vous utilisez personnellement n'en fait pas partie."),
  text("Liste de vos biens étrangers", "Pour chacun : de quoi il s'agit, le pays, son coût, le revenu qu'il a produit et tout gain ou toute perte.", foreign, true, "longtext"),
  doc("Relevés de comptes ou de courtiers étrangers", undefined, foreign, false),

  ask(medical, "Frais que vous avez payés pour vous-même, un conjoint ou une personne à charge et que l'assurance n'a pas couverts.", false),
  doc("Reçus de frais médicaux", "Joignez les relevés d'assurance qui montrent ce qui vous a été remboursé.", medical),

  ask(donations, undefined, false),
  doc("Reçus officiels de dons", "Reçus d'organismes de bienfaisance enregistrés. Les chèques et les relevés bancaires ne suffisent pas.", donations),

  ask(tuition, "Collège, université ou autre établissement d'enseignement postsecondaire.", false),
  doc("Attestations de frais de scolarité (T2202)", "Votre établissement la publie habituellement en ligne en février. Envoyez-en une pour chaque établissement.", tuition),

  ask(wfh, "Pour 2025, seule la méthode détaillée est offerte. Le taux fixe de 500 $ a pris fin après 2022.", false),
  doc("Formulaire T2200 signé par votre employeur", "La Déclaration des conditions de travail. Demandez-le à votre employeur ou aux ressources humaines.", wfh),
  doc("Registres des dépenses de la maison", "Le loyer si vous êtes locataire, l'électricité, le chauffage, l'eau, l'entretien mineur et l'Internet résidentiel, ainsi que la superficie de votre espace de travail par rapport à l'ensemble du logement. Les employés ne peuvent pas déduire les intérêts hypothécaires, les taxes foncières ni l'assurance habitation (les employés à commission peuvent en déduire une partie).", wfh, false),

  ask(quebec, "Les résidents du Québec produisent aussi une déclaration du Québec. Leurs feuillets font partie de la série des relevés Québec (RL)."),
  doc("Relevés 1 (RL-1) (revenus d'emploi et autres revenus)", feb, quebec),
  doc("Relevés 2 (RL-2) (revenus de retraite et de rentes)", feb, quebec, false),
  doc("Relevés 3 (RL-3) (revenus de placement)", feb, quebec, false),
  doc("Relevés 5 (RL-5) (prestations et indemnités)", feb, quebec, false),
  doc("Relevés 6 (RL-6) (prestations du Régime québécois d'assurance parentale)", feb, quebec, false),
  doc("Relevés 8 (RL-8) (études postsecondaires)", "Votre établissement l'envoie avec le T2202.", quebec, false),
  doc("Relevés 24 (RL-24) (frais de garde d'enfants)", "Votre prestataire de services de garde vous l'envoie.", quebec, false),
  doc("Relevé 31 (RL-31) (logement loué)", "Seulement si vous étiez locataire. Votre propriétaire vous en remet une copie d'ici la fin de février. Il est nécessaire pour le crédit d'impôt pour solidarité.", quebec, false),
  doc("Autres relevés Québec", "Par exemple RL-10, RL-11, RL-15, RL-16 ou RL-25.", quebec, false),
  doc("Avis de cotisation du Québec pour 2024", undefined, quebec, false),

  text("Y a-t-il autre chose que nous devrions savoir?", "Changements dans votre vie, nouveaux revenus ou question sur votre déclaration.", undefined, false, "longtext"),
]);

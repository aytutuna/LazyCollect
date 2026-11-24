// French twin of ../t2-year-end.ts
import { ask, doc, template, text } from "../build";

const assets = "La société a-t-elle acheté ou vendu de l'équipement, des véhicules ou des biens cette année?";
const loans = "Un actionnaire a-t-il emprunté de la société ou lui a-t-il prêté de l'argent?";
const payroll = "La société a-t-elle versé des salaires?";
const dividends = "La société a-t-elle versé des dividendes?";
const gst = "La société est-elle inscrite à la TPS/TVH?";
const minutes = "Y a-t-il eu des changements d'administrateurs, de dirigeants ou d'actionnaires, ou de nouvelles actions émises?";

export default template("t2-year-end", "T2 fin d'exercice de la société", [
  doc("Balance de vérification ou fichier de tenue de livres", "Une exportation de votre logiciel de comptabilité, ou le chiffrier que vous tenez."),
  doc("Relevés bancaires de chaque mois de l'exercice", "Tous les comptes de l'entreprise, de janvier jusqu'au dernier mois de la fin d'exercice.", undefined, true, "bank-statement"),
  doc("Relevés de cartes de crédit de chaque mois de l'exercice", "Toutes les cartes de l'entreprise."),
  doc("Déclaration T2 et avis de cotisation de l'an dernier", "La déclaration produite et l'avis de l'ARC, si nous ne les avons pas préparés."),
  doc("Relevés de prêts et d'hypothèques", "Solde à la fin de l'exercice et intérêts payés.", undefined, false),

  ask(assets),
  doc("Factures de l'équipement, des véhicules ou des biens achetés", "La date, le montant et ce qui a été acheté.", assets, false),
  doc("Documents de vente des actifs vendus", "La date, le prix et ce qui a été vendu.", assets, false),

  ask(loans),
  doc("Compte de prêt d'actionnaire", "Un prêt non remboursé à la fin de l'année suivant celle où il a été consenti peut être imposable pour l'actionnaire. Indiquez-nous la date et le montant de chaque prêt et de chaque remboursement.", loans),

  ask(payroll),
  doc("Sommaire de la paie de l'année", "Tiré de votre logiciel de paie ou de votre fournisseur.", payroll),
  doc("Sommaire T4 et feuillets T4", "Produits au plus tard le dernier jour de février.", payroll),

  ask(dividends),
  doc("Feuillets T5 et sommaire T5", "Produits au plus tard le dernier jour de février. Aucun feuillet n'est nécessaire pour les montants de moins de 50 $ par personne.", dividends),
  doc("Résolutions de dividendes", "La résolution des administrateurs pour chaque dividende.", dividends, false),

  ask(gst),
  doc("Déclarations de TPS/TVH produites cette année", "Ou la confirmation de production pour chaque période.", gst),

  ask(minutes),
  doc("Mises à jour du livre des procès-verbaux", "Résolutions, registre des actions et tout changement d'administrateurs ou de dirigeants.", minutes),

  doc("Reçus des dépenses importantes ou inhabituelles", undefined, undefined, false),
  text("Y a-t-il eu quelque chose d'inhabituel cette année?", "Par exemple un nouveau prêt, une subvention, la vente d'une partie de l'entreprise ou un nouveau propriétaire.", undefined, false, "longtext"),
]);

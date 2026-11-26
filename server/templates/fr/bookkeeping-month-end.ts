// French twin of ../bookkeeping-month-end.ts
import { ask, doc, template, text } from "../build";

const payroll = "Avez-vous versé de la paie ce mois-ci?";
const big = "Avez-vous contracté un prêt, acheté de l'équipement, ou investi ou retiré de l'argent de propriétaire ce mois-ci?";

export default template("bookkeeping-month-end", "Tenue de livres de fin de mois", [
  doc("Relevés bancaires du mois", "Tous les comptes de l'entreprise, en PDF, téléchargés de votre banque.", undefined, true, "bank-statement"),
  doc("Relevés de cartes de crédit du mois", "Toutes les cartes de l'entreprise."),
  doc("Factures de vente émises", "Une liste tirée de votre système de facturation, ou des copies des factures."),
  doc("Reçus des dépenses payées", "Les photos conviennent. Incluez tout ce qui a été payé comptant ou avec une carte personnelle."),

  ask(payroll),
  doc("Rapport de paie du mois", "Tiré de votre logiciel de paie ou de votre fournisseur.", payroll),

  ask(big, "Par exemple un nouveau prêt, un véhicule, un ordinateur, ou de l'argent transféré entre vous et l'entreprise."),
  text("Que s'est-il passé, et à quelle date?", undefined, big, true, "longtext"),

  doc("Ventes comptant sans facture", "Feuilles de ventes quotidiennes ou rapports de caisse.", undefined, false),
  text("Y a-t-il autre chose que nous devrions savoir sur ce mois?", undefined, undefined, false, "longtext"),
]);

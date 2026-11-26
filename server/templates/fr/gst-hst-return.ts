// French twin of ../gst-hst-return.ts
import { ask, doc, template } from "../build";

const qst = "Êtes-vous inscrit à la taxe de vente du Québec (TVQ)?";
const credit = "Avez-vous émis des notes de crédit ou radié des factures impayées pendant cette période?";

export default template("gst-hst-return", "Déclaration de TPS/TVH", [
  doc("Registres des ventes de la période", "Un rapport de ventes ou une liste de factures. Séparez les ventes taxables, détaxées et exonérées si possible."),
  doc("Registres des achats et dépenses de la période", "Reçus et factures de fournisseurs pour les crédits de taxe sur les intrants. Les reçus de 100 $ ou plus doivent porter le numéro de TPS/TVH du vendeur; ceux de 500 $ ou plus doivent aussi porter votre nom et une description de ce que vous avez acheté."),
  doc("Relevés bancaires de la période", "Pour vérifier les dépôts par rapport à vos ventes.", undefined, false, "bank-statement"),

  ask(credit),
  doc("Notes de crédit ou liste des radiations", undefined, credit),

  ask(qst, "Revenu Québec administre la TVQ. Elle peut être produite avec la TPS/TVH dans une seule déclaration combinée."),
  doc("TVQ perçue et payée pour la période", "Le rapport de taxes de votre logiciel de comptabilité, avec les montants de TVQ.", qst),

  doc("Avis de l'ARC ou de Revenu Québec", "Tout ce que vous avez reçu depuis la dernière déclaration.", undefined, false),
]);

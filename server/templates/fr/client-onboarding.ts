// French twin of ../client-onboarding.ts
import { ask, doc, template, text } from "../build";

const business = "Possédez-vous une entreprise ou une société?";
const moved = "Votre nom ou votre adresse a-t-il changé depuis votre dernière déclaration?";

export default template("client-onboarding", "Accueil d'un nouveau client", [
  doc("Pièce d'identité avec photo", "Sert uniquement à confirmer votre identité. Le recto de votre permis ou la page du passeport avec la photo suffit."),
  doc("Lettre de confirmation du NAS", "Veuillez ne pas envoyer de photo de votre carte d'assurance sociale. Si vous avez la lettre de Service Canada, vous pouvez l'envoyer. Sinon, laissez ce champ vide et nous conviendrons d'une façon plus sûre d'obtenir le numéro.", undefined, false),
  doc("Avis de cotisation de la dernière année d'imposition", "Ouvrez une session dans Mon dossier de l'ARC et allez à Déclarations de revenus, ou utilisez la copie reçue par la poste.", undefined, true, "noa"),
  doc("Avis de cotisation de l'année précédente", "Au même endroit que le précédent.", undefined, true, "noa"),

  ask("Nous avez-vous autorisés comme représentants auprès de l'ARC?", "Dans Mon dossier de l'ARC, choisissez Profil, puis Ajouter sous Représentant autorisé. Si nous vous envoyons une demande, vous la confirmez à cet endroit. Le formulaire papier ne nous donne accès que par téléphone et par la poste."),
  doc("Lettre de mission, signée", "Nous vous envoyons la lettre. Signez-la, puis ajoutez une photo ou une numérisation de la page signée."),

  ask(moved),
  text("Votre nouveau nom ou votre nouvelle adresse", undefined, moved),

  ask(business),
  doc("Statuts de constitution ou enregistrement de l'entreprise", "Et le numéro d'entreprise si vous en avez un.", business, false),
]);

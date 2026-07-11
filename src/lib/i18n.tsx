import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Lang = "en" | "hi" | "es" | "fr";

export const LANGUAGES: { code: Lang; label: string; native: string }[] = [
  { code: "en", label: "English", native: "English" },
  { code: "hi", label: "Hindi", native: "हिन्दी" },
  { code: "es", label: "Spanish", native: "Español" },
  { code: "fr", label: "French", native: "Français" },
];

type Dict = Record<string, string>;

const en: Dict = {
  dashboard: "Dashboard",
  team: "Team",
  settings: "Settings",
  signOut: "Sign out",
  signOutConfirm: "Sign out of Earthpuls?",
  admin: "Admin",
  goodMorning: "Good morning",
  goodAfternoon: "Good afternoon",
  goodEvening: "Good evening",
  language: "Language",
  languageDesc: "Choose the language for the interface.",
  profile: "Profile",
  profilePicture: "Profile picture",
  uploadPhoto: "Upload photo",
  removePhoto: "Remove",
  displayName: "Display name",
  save: "Save",
  saving: "Saving…",
  saved: "Saved",
  photoTooLarge: "Photo too large — pick one under 3 MB.",
  photoUpdated: "Photo updated",
  photoRemoved: "Photo removed",
  profileUpdated: "Profile updated",
  languageUpdated: "Language updated",
};

const hi: Dict = {
  dashboard: "डैशबोर्ड",
  team: "टीम",
  settings: "सेटिंग्स",
  signOut: "साइन आउट",
  signOutConfirm: "Earthpuls से साइन आउट करें?",
  admin: "एडमिन",
  goodMorning: "सुप्रभात",
  goodAfternoon: "नमस्ते",
  goodEvening: "शुभ संध्या",
  language: "भाषा",
  languageDesc: "इंटरफ़ेस की भाषा चुनें।",
  profile: "प्रोफ़ाइल",
  profilePicture: "प्रोफ़ाइल फ़ोटो",
  uploadPhoto: "फ़ोटो अपलोड करें",
  removePhoto: "हटाएं",
  displayName: "प्रदर्शन नाम",
  save: "सहेजें",
  saving: "सहेज रहे हैं…",
  saved: "सहेजा गया",
  photoTooLarge: "फ़ोटो बहुत बड़ी है — 3 MB से छोटी चुनें।",
  photoUpdated: "फ़ोटो अपडेट हो गई",
  photoRemoved: "फ़ोटो हटा दी गई",
  profileUpdated: "प्रोफ़ाइल अपडेट हो गई",
  languageUpdated: "भाषा अपडेट हो गई",
};

const es: Dict = {
  dashboard: "Panel",
  team: "Equipo",
  settings: "Ajustes",
  signOut: "Cerrar sesión",
  signOutConfirm: "¿Cerrar sesión de Earthpuls?",
  admin: "Admin",
  goodMorning: "Buenos días",
  goodAfternoon: "Buenas tardes",
  goodEvening: "Buenas noches",
  language: "Idioma",
  languageDesc: "Elige el idioma de la interfaz.",
  profile: "Perfil",
  profilePicture: "Foto de perfil",
  uploadPhoto: "Subir foto",
  removePhoto: "Quitar",
  displayName: "Nombre a mostrar",
  save: "Guardar",
  saving: "Guardando…",
  saved: "Guardado",
  photoTooLarge: "Foto demasiado grande — elige una menor de 3 MB.",
  photoUpdated: "Foto actualizada",
  photoRemoved: "Foto eliminada",
  profileUpdated: "Perfil actualizado",
  languageUpdated: "Idioma actualizado",
};

const fr: Dict = {
  dashboard: "Tableau de bord",
  team: "Équipe",
  settings: "Paramètres",
  signOut: "Déconnexion",
  signOutConfirm: "Se déconnecter d'Earthpuls ?",
  admin: "Admin",
  goodMorning: "Bonjour",
  goodAfternoon: "Bon après-midi",
  goodEvening: "Bonsoir",
  language: "Langue",
  languageDesc: "Choisissez la langue de l'interface.",
  profile: "Profil",
  profilePicture: "Photo de profil",
  uploadPhoto: "Téléverser",
  removePhoto: "Retirer",
  displayName: "Nom affiché",
  save: "Enregistrer",
  saving: "Enregistrement…",
  saved: "Enregistré",
  photoTooLarge: "Photo trop grande — choisissez-en une de moins de 3 Mo.",
  photoUpdated: "Photo mise à jour",
  photoRemoved: "Photo retirée",
  profileUpdated: "Profil mis à jour",
  languageUpdated: "Langue mise à jour",
};

const DICTS: Record<Lang, Dict> = { en, hi, es, fr };

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: keyof typeof en) => string };
const I18nCtx = createContext<Ctx | null>(null);

const STORAGE_KEY = "earthpuls.lang";

export function LanguageProvider({ children }: { children: ReactNode }) {
  // Read stored language after mount to avoid SSR/hydration mismatch.
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Lang | null;
      if (stored && DICTS[stored]) setLangState(stored);
    } catch {}
  }, []);

  const value = useMemo<Ctx>(() => ({
    lang,
    setLang: (l) => {
      setLangState(l);
      try { localStorage.setItem(STORAGE_KEY, l); } catch {}
      if (typeof document !== "undefined") document.documentElement.lang = l;
    },
    t: (key) => DICTS[lang][key] ?? DICTS.en[key] ?? String(key),
  }), [lang]);

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nCtx);
  if (!ctx) throw new Error("useI18n must be used inside <LanguageProvider>");
  return ctx;
}

export function useT() {
  return useI18n().t;
}
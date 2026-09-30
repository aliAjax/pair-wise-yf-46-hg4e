import i18n from "i18next";
import { initReactI18next } from "react-i18next";

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: { title: "新闻直播编排台", rundown: "串联单", changes: "突发变更", queue: "应急队列", conflicts: "冲突箱", applications: "待审申请", history: "操作历史" } },
    en: { translation: { title: "News Rundown Control", rundown: "Rundown", changes: "Breaking changes", queue: "Emergency queue", conflicts: "Conflict box", applications: "Pending applications", history: "History" } }
  },
  lng: "zh",
  fallbackLng: "zh",
  interpolation: { escapeValue: false }
});

export default i18n;

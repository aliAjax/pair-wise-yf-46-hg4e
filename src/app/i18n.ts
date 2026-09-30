import i18n from "i18next";
import { initReactI18next } from "react-i18next";

i18n.use(initReactI18next).init({
  resources: {
    zh: {
      translation: {
        title: "新闻直播编排台",
        rundown: "串联单",
        approvals: "插播审批",
        takeover: "岗位接管",
        queue: "应急队列",
        conflicts: "冲突箱",
        reconciliations: "对账记录",
        changes: "突发变更",
        history: "操作历史"
      }
    },
    en: {
      translation: {
        title: "News Rundown Control",
        rundown: "Rundown",
        approvals: "Approvals",
        takeover: "Takeover",
        queue: "Emergency queue",
        conflicts: "Conflict bin",
        reconciliations: "Reconciliation",
        changes: "Breaking changes",
        history: "History"
      }
    }
  },
  lng: "zh",
  fallbackLng: "zh",
  interpolation: { escapeValue: false }
});

export default i18n;
